// One decision: may the agent propose, and if not, what exactly would change
// that?
//
// WHAT THIS COLLAPSES. Sixteen independent places could block the agent: nine
// checks inside `evaluateDiscovery`, four vetoes computed separately in the
// orchestrator and ORed with the gate's own outcome, five refusals in the
// architecture audits, and seven MAX_/MIN_ constants spread across two files.
// No single function could answer "why is this stuck", and on 2026-10-16 three
// of them turned out to be unclearable — the gate demanded a field the
// response template had no slot for, held out for a `note` nobody had been
// told to write, and kept refusing after the round budget was spent because
// the escape hatch was overridden by vetoes that never read it.
//
// THE INVARIANT, and the reason this file exists at all:
//
//   every Block names the mutation that clears it, and applying that mutation
//   clears it.
//
// `clears` is a REQUIRED field, so a block that cannot say what would fix it
// is not merely discouraged — it cannot be constructed. `satisfy()` below is
// the executable definition of each mutation, which is what lets the property
// test check the invariant instead of trusting it. Anything worth telling the
// agent that does NOT have a clearing mutation is advice, and advice does not
// block.
import { briefDimensions, isPlatformDimension, recordDimensions, type WorkingBrief } from './discovery';
import { designableBarriers, convertersSettled, type Barrier, type Converters } from './findings';
import { outstanding, exhausted } from './record';

/** Lines of enquiry to weigh before designing. Being sure of one is not the same as having considered the alternatives. */
export const MIN_DIMENSIONS = 3;

/** Rounds of questions before the agent must work with what it has. */
export const MAX_ROUNDS = 8;

/**
 * A change to the record that would unblock the agent.
 *
 * Every variant is something the model can emit in one turn, or the
 * application can apply on the user's behalf. That is the test of whether a
 * block is fair: if nothing in this union would clear it, it should not be
 * blocking.
 */
export type Mutation =
  | { field: 'successCriteria'; how: string }
  | { field: 'converters'; how: string }
  | { field: 'barriers'; how: string }
  | { field: 'dimensions'; how: string }
  | { field: 'dimensionNote'; name: string; how: string }
  | { field: 'reply'; questionId: string; how: string }
  /**
   * A change to the PROPOSAL rather than to the record.
   *
   * The distinction is real and worth keeping in the type. A record mutation
   * can be applied by `satisfy()` and is therefore provable; a proposal
   * mutation is something the model must write into the next proposal, so the
   * invariant checks that the block names a field on the proposal instead of
   * trying to synthesise one.
   */
  | { field: 'hypotheses'; how: string }
  | { field: 'touches'; how: string }
  | { field: 'experiment'; how: string }
  | { field: 'treatmentSplit'; how: string };

export interface Block {
  /** Stable identity, so two turns can be compared and only the DELTA shown. */
  code:
    | 'no-participation'
    | 'success-unsettled'
    | 'converters-unknown'
    | 'no-barrier'
    | 'too-few-dimensions'
    | 'dimension-unreasoned'
    | 'awaiting-reply'
    | 'belief-untested'
    | 'cadence-unnamed'
    | 'split-without-trend'
    | 'nothing-tested';
  /** Said to the user, in their terms. Never names a field or an id. */
  reason: string;
  /** What would clear it. Required by construction. */
  clears: Mutation;
}

export interface Decision {
  proceed: boolean;
  blocks: Block[];
  /** Worth saying, but never a reason to refuse. */
  advice: string[];
  /** Why the agent is proceeding despite open blocks, when that applies. */
  forcedBy?: 'budget' | 'user';
}

/**
 * May the agent propose?
 *
 * THE BUDGET IS CHECKED FIRST AND NOTHING OVERRIDES IT. This is the shape of
 * the third deadlock: `evaluateDiscovery` already returned `ready_for_strategy`
 * at the round limit, and four vetoes computed elsewhere were ORed with it, so
 * the escape existed and was ignored. Here the escape is the first branch and
 * the blocks are reported as advice, so the agent proceeds AND the user still
 * sees what was assumed.
 */
export function decide(
  brief: WorkingBrief,
  opts: { proceedRequested?: boolean; proposed?: ProposalUnderReview | null; building?: boolean } = {},
): Decision {
  // CADENCE IS CHECKED WHEN THE PLAN IS WRITTEN, NOT WHEN IT IS BUILT.
  //
  // `building` is true on a Confirm or a refinement, where the manager has
  // already approved this plan. Refusing it there would be both useless and
  // insulting: there is nothing they can do about a missing field from the
  // build turn, and the moment to have said so was before they agreed.
  const blocks = [
    ...blocksFor(brief),
    ...proposalBlocks(brief, opts.proposed ?? null),
    ...(opts.building ? [] : cadenceBlocks(opts.proposed ?? null)),
    ...(opts.building ? [] : trendBlocks(brief, opts.proposed ?? null)),
  ];
  const advice = adviceFor(brief);

  if (opts.proceedRequested) {
    return { proceed: true, blocks: [], advice: [...advice, ...blocks.map((b) => b.reason)], forcedBy: 'user' };
  }
  if (brief.rounds >= MAX_ROUNDS) {
    return { proceed: true, blocks: [], advice: [...advice, ...blocks.map((b) => b.reason)], forcedBy: 'budget' };
  }
  return { proceed: blocks.length === 0, blocks, advice };
}

/** Just enough of a proposal to check it against the record. */
export interface ProposalUnderReview {
  strategy?: {
    hypotheses?: string[];
    unknowns?: string[];
    touches?: { day: number; path: string }[];
    /**
     * The agent's own verdict on each strategic option. Read here for the
     * same reason `checkExperimentClaims` reads it: a claim the agent makes
     * about its own design is the one thing the application can check
     * without judging the design itself.
     */
    strategyOptions?: { option: string; verdict: string; why?: string }[];
  } | null;
  openItems?: { kind: string }[];
}

/**
 * Every path, with how many sends it carries.
 *
 * THE RULE WAS BACKWARDS AND THIS IS THE CORRECTION, 2026-10-22. It used to
 * measure the BUSIEST path on the reasoning that a group which mostly acts
 * unprompted may need only a light touch. Read against the run that prompted
 * all of this, that is exactly the failure: the high-limit cohort — the one
 * that self-activates anyway — got two nudges and cleared the gate, while
 * everyone else, the people the campaign exists for, got a single send that
 * nothing ever looked at. A thin path hid behind a busier one.
 *
 * EVERY NAMED PATH NEEDS A SEQUENCE. Lighter still means fewer, and fewer
 * still means a mid-window touch and a last chance before the window closes.
 * A single row is not a sequence, whichever group it belongs to.
 *
 * A HOLDOUT IS NOT A PATH. `touches` lists customer-facing sends, so an arm
 * that is deliberately not messaged contributes no rows and never appears
 * here — the rule cannot accidentally demand two sends for a control group.
 * A holdout listed as one row fails, correctly: it does not belong in this
 * list at all.
 */
const sendsPerPath = (touches: { path?: string }[]): { path: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const t of touches) {
    const key = t.path?.trim() || 'all';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([path, count]) => ({ path, count }));
};

/**
 * Blocks that are about the PROPOSAL, not the record.
 *
 * Separated from `blocksFor` because the two are checked at different moments
 * and only one of them is synthesisable: a record block can be cleared by
 * `satisfy()` and proved, while a proposal block is cleared by the model
 * writing something different next time.
 *
 * Returns nothing when there is no proposal, which is what keeps a discovery
 * turn from being refused for the shape of a strategy it has not written.
 */
export function proposalBlocks(brief: WorkingBrief, proposed: ProposalUnderReview | null): Block[] {
  if (!proposed) return [];
  const beliefs = (brief.dimensions ?? []).filter((d) => d.basis === 'user-belief');
  if (beliefs.length === 0) return [];
  // Three honest ways to say it is untested, and any of them satisfies this.
  // Insisting on one specific field would be a formatting rule rather than a
  // correctness one.
  const named = Boolean(
    proposed.strategy?.hypotheses?.length ||
      proposed.strategy?.unknowns?.length ||
      proposed.openItems?.some((i) => i.kind === 'strategic-ambiguity'),
  );
  if (named) return [];
  return [
    {
      code: 'belief-untested',
      reason: `This design rests on ${beliefs
        .map((d) => `"${d.name}"`)
        .join(' and ')}, which you offered as your own reading rather than something measured, and nothing in the plan says it is untested.`,
      clears: {
        field: 'hypotheses',
        how: 'Name it as a hypothesis in the proposal, or ask the question that would separate the competing explanations.',
      },
    },
  ];
}

/**
 * A plan that never names its sends.
 *
 * MEASURED 2026-10-22. A fourteen-day activation plan described "a staggered
 * multi-touch sequence over the full 14 days, spaced by read/response rather
 * than a fixed clock" and listed not one message. The manager approved a
 * cadence they could not see, and the build turn then invented it from that
 * sentence. Under-dosing is invisible in prose: three touches and nine read
 * the same.
 *
 * NO WINDOW IS PARSED, deliberately. There is no structured window on the
 * brief — "14 days" lives only inside free text — and reading a number out of
 * prose to CREATE a block would break the rule this application runs on: a
 * judgement about someone's words may only ever release a block, never raise
 * one (see `record.ts`). So the requirement is unconditional and the tool
 * schema carries most of it with `minItems: 2`. This is the backstop for a
 * payload that arrives without the field at all.
 */
export function cadenceBlocks(proposed: ProposalUnderReview | null): Block[] {
  if (!proposed?.strategy) return [];
  const touches = proposed.strategy.touches ?? [];
  const thin = sendsPerPath(touches).filter((p) => p.count < 2);
  if (touches.length && !thin.length) return [];
  return [
    {
      code: 'cadence-unnamed',
      reason:
        touches.length === 0
          ? 'This plan does not say when the messages go out. "Multi-touch" is not a sequence a campaign manager can approve — name each send, the day it lands, and what happens if it does not.'
          : `${thin.map((p) => (p.path === 'all' ? 'The plan' : `"${p.path}"`)).join(' and ')} ${
              thin.length === 1 ? 'gets' : 'get'
            } a single message, which is not a sequence anyone can approve. Give that path a mid-window reminder and a last chance before the window closes.`,
      clears: {
        field: 'touches',
        how: 'List every send in "touches": day, channel, path, what it is for, and what happens if it does not land. Every named path needs at least two.',
      },
    },
  ];
}

/**
 * A trend the MANAGER has seen, which is the only thing a treatment cut may
 * rest on.
 *
 * `basis: 'user'` is what they stated; `status: 'retained'` is the agent
 * saying it resolved and was used. Both are needed, and the second is what
 * separates a factor they described from one they merely NAMED. "We do not
 * track prior EMI" is recorded against the same dimension name, with status
 * `unavailable` or `deferred` — a fact about the data, not a pattern they
 * have observed. Reading only the basis would let an untracked factor
 * authorise a split, which is the live defect this exists to stop.
 *
 * A described audience counts too: if they can say who converts today, they
 * have seen the trend by definition.
 */
const statedTrend = (brief: WorkingBrief): boolean =>
  briefDimensions(brief).some((d) => d.basis === 'user' && d.status === 'retained') ||
  (brief.converters?.knowledge === 'known' && brief.converters.basis === 'user');

/**
 * TWO RULES ABOUT WHAT A PLAN MAY DO WITH A TREND IT DOES NOT HAVE.
 *
 * MEASURED on a live EMI run, 2026-10-23. Discovery asked the right question
 * and the manager answered it plainly: they do not track prior EMI, category
 * or ticket size, they want one track, and they want the first run to
 * generate that signal. The strategy then split day-0 copy by prior EMI
 * versus first-time and said the manager had flagged that factor — about a
 * factor they had just said they do not record — and parked the wording test
 * in "hypotheses for future" so this run tested nothing at all.
 *
 * Both halves are failures of the same kind: the plan spent a signal it did
 * not have, and declined to produce the one it was asked for.
 *
 * WHY THE GATE AND NOT THE PROMPT. §2, §3 and §6 already say all of this in
 * words, and the run above happened anyway. A rule the application enforces
 * against the proposal is the only kind that has moved this agent's output.
 *
 * BEFORE CONFIRM, NEVER AFTER. Same reasoning as `cadenceBlocks`: `building`
 * is true once the manager has approved, and refusing then leaves them with
 * an approval that did nothing and nothing they can do about it.
 */
export function trendBlocks(brief: WorkingBrief, p: ProposalUnderReview | null): Block[] {
  const s = p?.strategy;
  if (!s) return [];
  const verdict = (name: string) =>
    (s.strategyOptions ?? []).find((o) => String(o.option ?? '').toLowerCase().startsWith(name))?.verdict;
  const tests = verdict('experiment') === 'used';
  const cuts = verdict('segmentation') === 'used';
  // A path that is not "all" is a group being treated differently. Counted as
  // well as read from the verdict, because the defect was a plan that split
  // the copy while its own options list said nothing about segmentation.
  const paths = new Set(
    (s.touches ?? []).map((t) => String(t.path ?? '').trim().toLowerCase()).filter((x) => x && x !== 'all'),
  );
  const splits = cuts || paths.size >= 2;

  // ONE PRECONDITION, TWO WAYS OF FAILING IT.
  //
  // Neither rule has anything to say once the manager has stated a trend, or
  // once the plan runs a comparison:
  //
  //  - a stated trend is a pattern they have SEEN, so there is something real
  //    to cut on and the cut itself is what produces the reading;
  //  - a comparison produces the reading directly.
  //
  // What is left is a plan with neither, and it fails in one of two ways: it
  // cuts the journey on a factor nobody has observed, or it runs flat and
  // learns nothing. The first is the sharper thing to say, so a plan doing
  // both gets one block rather than two making the same point twice.
  //
  // An earlier draft keyed the test rule on `converters.knowledge` instead,
  // which demanded an experiment ON TOP of a split the manager had asked for
  // — a second instrument for a question the first one answers.
  if (statedTrend(brief) || tests) return [];

  if (splits) {
    return [
      {
        code: 'split-without-trend',
        reason:
          'This plan gives different groups different messages, and nothing you have told me says those groups behave differently. A factor you do not track cannot decide who gets what — it is the thing this campaign should be measuring, not the thing it acts on.',
        clears: {
          field: 'treatmentSplit',
          how: 'Either put everyone on one track and compare the groups in "measurement", or make the split a real experiment with randomly assigned arms. A cut by a customer factor needs a trend the manager has stated they have seen.',
        },
      },
    ];
  }

  {
    const parked = (s.hypotheses ?? []).length > 0;
    return [
      {
        code: 'nothing-tested',
        reason: parked
          ? 'Nobody can say yet who responds, and this plan keeps its test for a future run. There is no later run to inherit it: with nothing compared this time, the next campaign starts exactly as blind as this one.'
          : 'Nobody can say yet who responds, and this plan compares nothing, so it will return one number with nothing to read it against. The first run is where the signal comes from.',
        clears: {
          field: 'experiment',
          how: 'Run one comparison this time — wording, dosage, channel or timing, whichever this objective is actually uncertain about — and mark Experimentation "used" with what each arm gets and how the result would be read.',
        },
      },
    ];
  }
}

/** Every reason the agent may not propose yet, most actionable first. */
export function blocksFor(brief: WorkingBrief): Block[] {
  const out: Block[] = [];

  // Has the user taken part at all? A record the agent filled in by itself is
  // not discovery, however complete it looks.
  if (brief.answers.length === 0) {
    out.push({
      code: 'no-participation',
      reason: 'I have not asked you anything yet, so a strategy now would be mine rather than yours.',
      clears: { field: 'reply', questionId: '', how: 'The user answers anything at all.' },
    });
    // Nothing below this is meaningful before the first exchange.
    return out;
  }

  const waiting = outstanding(brief);
  if (waiting.length > 0) {
    out.push({
      code: 'awaiting-reply',
      reason: `I am still waiting on this: ${waiting.map((q) => `"${q.text}"`).join(' and ')}`,
      clears: { field: 'reply', questionId: waiting[0].id, how: 'The user replies, or the question is assumed past.' },
    });
  }

  if (!(brief.successCriteria ?? []).length) {
    out.push({
      code: 'success-unsettled',
      reason: 'I still do not know how you would judge whether this worked, and that changes who the campaign goes after.',
      clears: { field: 'successCriteria', how: 'Record how the business would judge success, in their words.' },
    });
  }

  // ONE block again, and the second one is gone rather than reworded.
  //
  // There were two: `converters-unknown` for "nothing recorded", and
  // `converters-unreacted` for "candidates up, manager has not replied yet".
  // The split existed because the clearability invariant would not accept one
  // block for both — "record who converts" does not clear a state that is
  // waiting on a reply, so a single block would have named a fix that does
  // not work.
  //
  // `converters-unreacted` is unreachable now that `convertersSettled` stops
  // demanding that reply, and the reason it stops is in `findings.ts`: the
  // turn it produced asked the manager to pick a targeting group out of the
  // agent's own guesses. Deleted rather than left dead, so nobody has to work
  // out later whether an unreachable branch was load-bearing.
  if (!convertersSettled(brief.converters)) {
    out.push({
      code: 'converters-unknown',
      reason: 'I do not yet know who does this today, so I cannot say who the campaign should go after.',
      clears: {
        field: 'converters',
        how: 'Record who converts, or that nobody knows plus two candidate trends resting on different things. Trends cut the treatment; the entry stays every eligible customer.',
      },
    });
  }

  if (designableBarriers(brief.barriers).length === 0) {
    out.push({
      code: 'no-barrier',
      reason: 'I do not yet know what is stopping them, so there is nothing for the campaign to work on.',
      clears: { field: 'barriers', how: 'Record at least one barrier traceable to something the user said.' },
    });
  }

  const dims = (brief.dimensions ?? []).filter((d) => !isPlatformDimension(d.name));
  if (dims.length < MIN_DIMENSIONS) {
    out.push({
      code: 'too-few-dimensions',
      reason: `I have only weighed ${dims.length} angle${dims.length === 1 ? '' : 's'} so far, and being confident about one is not the same as having considered the alternatives.`,
      clears: { field: 'dimensions', how: `Raise at least ${MIN_DIMENSIONS} lines of enquiry.` },
    });
  }

  // A line of enquiry raised and then dropped with no reason. Ruling
  // something out is a decision, so it needs one.
  //
  // NOTE the narrowed condition. This used to also fire on
  // `basis: 'assumption'` with no note, which is what blocked a real session
  // for five turns: the agent's own assumption, about a thing the manager had
  // already said they could not settle. `settleUnknowns` in record.ts now
  // writes that note from the user's own "not sure", so by the time this runs
  // the only cases left are genuinely unexplained drops.
  for (const d of dims) {
    if (d.basis !== 'none') continue;
    if ((d.note ?? '').trim().length > 0) continue;
    out.push({
      code: 'dimension-unreasoned',
      reason: `I raised "${d.name}" and then let it go without saying why.`,
      clears: { field: 'dimensionNote', name: d.name, how: 'Say what was concluded or why it was ruled out.' },
    });
  }

  return out;
}

/**
 * True of the record, worth saying, and never a reason to refuse.
 *
 * This is where things go that the old gate turned into blocks it could not
 * clear. A question that has used up its one re-ask is the clearest case:
 * there is nothing the agent can do about it, so refusing on it can only
 * loop — but silently designing past it would hide a real gap.
 */
export function adviceFor(brief: WorkingBrief): string[] {
  const out: string[] = [];
  for (const q of exhausted(brief)) {
    out.push(`I asked "${q.text}" twice and will proceed on an assumption rather than ask a third time.`);
  }
  const unverified = (brief.barriers ?? []).filter((b: Barrier) => b.basis === 'assumption');
  if (unverified.length > 0 && designableBarriers(brief.barriers).length === unverified.length) {
    out.push('Every reason I have for their behaviour is my own inference, so the campaign should test it rather than assume it.');
  }
  return out;
}

/**
 * Apply a mutation, minimally, as the model or the application would.
 *
 * This is the executable definition of "what clears this block", and it exists
 * so the invariant can be TESTED rather than asserted in a comment. It is
 * deliberately the laziest possible satisfaction of each mutation: if the
 * smallest valid change does not clear the block, the block was not honestly
 * described.
 *
 * Not a product path. The real record is filled by the agent and the user.
 */
export function satisfy(brief: WorkingBrief, m: Mutation): WorkingBrief {
  switch (m.field) {
    case 'reply':
      return {
        ...brief,
        rounds: brief.rounds + 1,
        answers: [...brief.answers, { round: brief.rounds + 1, text: 'answered' }],
        questions: (brief.questions ?? []).map((q) =>
          q.addressedInRound === undefined
            ? { ...q, answeredInRound: brief.rounds + 1, addressedInRound: brief.rounds + 1 }
            : q,
        ),
      };
    case 'successCriteria':
      return { ...brief, successCriteria: ['More of the behaviour, counted.'] };
    case 'converters': {
      const converters: Converters = {
        shape: 'Nobody can say yet.',
        basis: 'user',
        knowledge: 'none-yet',
        // Still recorded, because the brief keeps when a thing was raised.
        // It no longer decides anything: two distinct candidates settle this
        // on the turn they are recorded, so the mutation this block names
        // clears it without waiting for another reply.
        raisedInRound: brief.rounds,
        candidates: [
          { segment: 'A', restsOn: 'existing relationship', why: 'already onboarded' },
          { segment: 'B', restsOn: 'acquisition channel', why: 'already self-served once' },
        ],
      };
      return { ...brief, converters };
    }
    case 'barriers': {
      const barrier: Barrier = {
        id: 'stated',
        statement: 'They are not being told to act.',
        basis: 'user',
        lever: 'message',
      };
      return { ...brief, barriers: [...(brief.barriers ?? []), barrier] };
    }
    case 'dimensions': {
      // NAMES A REAL AGENT WOULD EMIT, and that is the point.
      //
      // This used to generate "Angle 1", "Angle 2". Those cleared the block in
      // the property test while proving nothing: `recordDimensions` now drops
      // any dimension that names a platform setting, so the path an agent
      // actually takes — raising three, having them silently refused — was
      // never exercised. A synthetic name that no model would produce makes
      // the invariant pass over a route nobody can walk.
      const dims = brief.dimensions ?? [];
      const realistic = [
        { name: 'Assigned credit limit', rationale: 'A larger limit may change who acts.' },
        { name: 'Already started the request', rationale: 'Stopping halfway is a different problem from never starting.' },
        { name: 'App on the phone', rationale: 'Someone who cannot act on the message needs a different route.' },
      ];
      // Routed through `recordDimensions`, not spliced onto the array. That
      // is the function an agent's output actually passes through, filter and
      // all, so the invariant is proved over the real path rather than around
      // it.
      const add = realistic.slice(0, Math.max(0, MIN_DIMENSIONS - dims.length)).map((d) => ({
        ...d,
        status: 'retained' as const,
        basis: 'user' as const,
      }));
      return recordDimensions(brief, add);
    }
    case 'hypotheses':
    case 'touches':
    case 'experiment':
    case 'treatmentSplit':
      // Not a record change, so there is nothing to synthesise here. The
      // clearability test treats a proposal mutation separately: it checks the
      // block names a field the model can write, not that the brief can be
      // bent into clearing it.
      return brief;
    case 'dimensionNote':
      return {
        ...brief,
        dimensions: (brief.dimensions ?? []).map((d) =>
          d.name.toLowerCase() === m.name.toLowerCase() ? { ...d, note: 'Ruled out, and here is why.' } : d,
        ),
      };
  }
}

/**
 * What changed since the last refusal.
 *
 * THE DEFECT THIS FIXES, measured. A live session refused five turns running
 * with the same opening paragraph and the same four-line dimension list, while
 * the questions underneath it changed every single turn. The agent was making
 * progress and the refusal was frozen, so the manager read five turns of work
 * as one stuck turn and wrote "im tired man".
 *
 * `Block.code` is a stable identity, which is what makes this possible at all:
 * the previous turn's codes are compared with this turn's, so the reply can
 * lead with what is NEW, acknowledge what was SETTLED, and mention what is
 * still open in one line instead of restating the whole state.
 */
export interface BlockDelta {
  fresh: Block[];
  carried: Block[];
  settled: Block['code'][];
}

export const blockDelta = (blocks: Block[], previous: readonly string[] = []): BlockDelta => {
  const before = new Set(previous);
  const now = new Set(blocks.map((b) => b.code));
  return {
    fresh: blocks.filter((b) => !before.has(b.code)),
    carried: blocks.filter((b) => before.has(b.code)),
    settled: [...before].filter((c) => !now.has(c as Block['code'])) as Block['code'][],
  };
};

/**
 * The refusal, written to the manager.
 *
 * Leads with progress when there is any, because a turn that settled something
 * and still cannot proceed is a different message from a turn that went
 * nowhere — and the old renderer made them identical.
 */
export function renderBlocks(d: BlockDelta, advice: string[] = []): string {
  const parts: string[] = [];
  if (d.settled.length) {
    parts.push(
      d.settled.length === 1
        ? 'That settled one of the things I was waiting on.'
        : `That settled ${d.settled.length} of the things I was waiting on.`,
    );
  }
  for (const b of d.fresh) parts.push(b.reason);
  if (d.carried.length) {
    // Named, not restated. The point is that they have not moved, and a
    // paragraph each would bury the one thing that did.
    //
    // `reason` ON BOTH BRANCHES, since 2026-10-21. The multi-carried line
    // used to join `clears.how`, and `how` is written for the MODEL: "Record
    // who converts, or that nobody knows plus two candidate segments resting
    // on different things." A campaign manager cannot act on that sentence —
    // it is not addressed to them, and it names our record rather than their
    // business. `reason` is the manager-facing half of a block and the single
    // branch already used it; the two were simply inconsistent.
    parts.push(
      d.carried.length === 1
        ? `Still open: ${d.carried[0].reason}`
        : `Still open, and unchanged since last time: ${d.carried.map((b) => b.reason).join(' ')}`,
    );
  }
  for (const a of advice) parts.push(a);
  return parts.join('\n\n');
}
