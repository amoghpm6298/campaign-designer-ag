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
import { briefDimensions, isPlatformDimension, isTimingDimension, recordDimensions, type WorkingBrief } from './discovery';
import { designableBarriers, convertersSettled, type Barrier, type Converters } from './findings';
import { journeyReacts } from './optionAudit';
import type { CampaignBlueprint } from './blueprint';
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
  | { field: 'treatmentSplit'; how: string }
  /** Which candidate wins, and what its journey DOES — not a change to the record. */
  | { field: 'architecture'; how: string };

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
    | 'nothing-tested'
    | 'unprobed-other-axes'
    | 'stacked-dimensions'
    | 'no-reaction'
    | 'single-channel-habit'
    | 'channel-spray';
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
    ...(opts.building ? [] : stackedDimensionBlocks(brief, opts.proposed ?? null)),
    ...(opts.building ? [] : reactionBlocks(opts.proposed ?? null)),
    ...(opts.building ? [] : channelJobBlocks(opts.proposed ?? null)),
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
    /**
     * `channel` and `ifStillUnconverted` are REQUIRED by the tool schema and
     * were simply not declared here, so the propose-time checks could not see
     * two of the five fields the model already sends. Optional in this type
     * because this PARSES a payload rather than constructing one — the same
     * reasoning as `ViewStep` in the client preview.
     */
    touches?: { day: number; path: string; channel?: string; ifStillUnconverted?: string }[];
    /** Only what a propose-time check reads: which candidate won, and what its journey DOES. */
    architectures?: { journey?: string; chosen?: boolean }[];
    /**
     * The agent's own verdict on each strategic option. Read here for the
     * same reason `checkExperimentClaims` reads it: a claim the agent makes
     * about its own design is the one thing the application can check
     * without judging the design itself.
     */
    strategyOptions?: { option: string; verdict: string; why?: string }[];
  } | null;
  openItems?: { kind: string }[];
  /**
   * The journey, WHEN THE TURN CARRIES ONE.
   *
   * `reactionBlocks` reads the same `journeyReacts` the build turn reads, so
   * the essay and the step list are checked against one definition rather
   * than two — a plan may not name unread-versus-read while its steps are a
   * ticket split and a clock.
   *
   * MEASURED, AND THE LIMIT IS WORTH STATING HERE. `propose_strategy` has no
   * blueprint in its schema and the propose turn returns none: on
   * `ui-s-1792748248345` the proposing turn (turn 4) carries `strategy` and
   * `blueprint: false`, and `systemForPhase(false)` tells the model the
   * grammar is "OMITTED THIS TURN" on purpose — the standing principle that
   * the plan is agreed in business terms before it is mapped to the builder.
   * So this is populated on a refinement, and on any turn whose payload does
   * carry steps, and is absent on today's first propose. Where it is absent
   * the prose checks stand alone; where it is present the steps decide.
   */
  blueprint?: CampaignBlueprint | null;
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
 * A DESCRIBED WHO PATTERN IS A TREND; A CLOCK IS NOT. This used to read every
 * dimension on the brief, timing included, so a manager who had only said
 * "most of them convert within thirty minutes" authorised a ticket-size split
 * they had never evidenced. When they act is not who acts: everyone passes
 * through the same clock. So this is now exactly the set `seenAxes` reads —
 * segmentation dimensions, `basis: 'user'`, `status: 'retained'` — and the two
 * rules cannot drift apart, because they are the same question asked twice.
 */
const statedTrend = (brief: WorkingBrief): boolean => seenAxes(brief).length > 0;

/**
 * Content words of a path label and of the dimension names on the brief.
 *
 * Used ONLY to release, never to block — see the arms rule in `trendBlocks`.
 */
const words = (text: string): string[] =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !['the', 'and', 'for', 'who', 'all', 'arm', 'path', 'group', 'with', 'vs', 'versus'].includes(w));

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
/**
 * TWO EVIDENCED PATTERNS MEAN A CHOICE, NOT FOUR PATHS.
 *
 * When the manager has seen two things that split who acts, the campaign cuts
 * on ONE of them — whichever changes the treatment of the barrier they named.
 * Running both produces four arms, quarters the group behind each, and buys a
 * second answer nobody asked for.
 *
 * Nesting is still legitimate when the two axes do different jobs — one sets
 * intensity, the other sets copy — and a plan that means that can say so. The
 * refusal is about stacking two cuts of the same kind, which is what shows up
 * as paths echoing two different retained dimensions.
 *
 * WHICH ONE TO PICK IS NOT THE APPLICATION'S CALL, and it must never become a
 * question to the manager: "which group should we go after" is the thing
 * discovery was rewritten to stop asking. The agent chooses and justifies.
 */
export function stackedDimensionBlocks(brief: WorkingBrief, p: ProposalUnderReview | null): Block[] {
  const axes = seenAxes(brief);
  if (axes.length < 2) return [];
  const paths = [...new Set((p?.strategy?.touches ?? []).map((t) => String(t.path ?? '').trim()).filter((x) => x && x.toLowerCase() !== 'all'))];
  if (!paths.length) return [];
  // Which retained axes do the path names echo? Same word match as
  // `trendBlocks`, and used the same way: it only ever adds a refusal when
  // TWO are echoed, so a near-miss costs nothing.
  const echoed = axes.filter((d) => {
    const own = new Set(words(d.name));
    return paths.some((path) => words(path).some((w) => own.has(w)));
  });
  if (echoed.length < 2) return [];
  return [
    {
      code: 'stacked-dimensions',
      reason: `This plan cuts the journey on ${echoed.map((d) => d.name).join(' AND ')}. Both are patterns you have seen, which is why it is tempting — but running both splits everyone four ways and makes each result harder to read. Pick the one that changes what we DO about the reason they are not converting, and keep the other as something to measure.`,
      clears: {
        field: 'treatmentSplit',
        how: 'Cut on ONE of the two, and say in "approach" why that one changes the treatment of the recorded barrier. If they genuinely do different jobs — one setting intensity, the other setting copy — say that explicitly rather than running two parallel cuts.',
      },
    },
  ];
}

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
  // ARMS ARE NOT A CUT, AND A TEST DOES NOT EXCUSE ONE.
  //
  // An experiment arm is a treatment variant assigned at random; it makes no
  // claim about who these people are, so it needs no trend behind it. A path
  // named for a customer property — "Prior EMI users", "First-time", a ticket
  // band — does make that claim, and needs one.
  //
  // THE FIRST DRAFT LET A WORDING TEST LEGALISE A PRIOR-EMI COPY SPLIT,
  // because `tests` short-circuited the whole function. Declaring an
  // experiment somewhere in the plan is not permission to cut the journey on
  // a factor nobody tracks.
  //
  // THE MATCH ONLY EVER RELEASES. Any two named paths are treated as a
  // customer cut by default; they are let through as arms only when the plan
  // declares an experiment, does NOT claim segmentation, and no path echoes a
  // factor already on the record. Reading it the other way round — guessing
  // "that looks like an arm" — would have the application inventing a reason
  // to allow a split, which is the mistake `record.ts` warns about pointed at
  // the model instead of the manager.
  const onRecord = new Set(briefDimensions(brief).flatMap((d) => words(d.name)));
  const echoesAFactor = [...paths].some((p) => words(p).some((w) => onRecord.has(w)));
  const armsOnly = tests && !cuts && !echoesAFactor;
  const customerCut = (cuts || paths.size >= 2) && !armsOnly;

  // ORDER MATTERS. The split rule is checked first and independently of
  // `tests`, so an experiment cannot buy its way past it. A split the manager
  // DID state a trend for is the learning instrument, so it needs no second
  // one — that is the only thing `statedTrend` releases here.
  if (customerCut) {
    if (statedTrend(brief)) return [];
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

  if (!tests) {
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
  return [];
}

/** The two journey behaviours in which the NEXT step depends on the customer. */
const REACTIVE_JOURNEYS = ['branch-on-response', 'wait-for-event'];

/**
 * What a touch says it does when the message does not land, sorted into the
 * outcomes a channel can actually distinguish.
 *
 * A CHEAP STRING CHECK, DELIBERATELY. The blueprint is the place to read a
 * journey properly, and `optionAudit` already does that on the build turn.
 * Here there is no journey yet — only the manager-facing list — so the
 * question is narrower: does the plan distinguish the person who never got it
 * from the person who read it and did nothing? Two different outcomes named
 * anywhere in the list is the whole bar.
 */
const namedOutcomes = (touches: { ifStillUnconverted?: string }[]): Set<string> => {
  const text = touches.map((t) => String(t.ifStillUnconverted ?? '')).join(' ␞ ').toLowerCase();
  const found = new Set<string>();
  // LANDED CASES ONLY, since 2026-10-23. `not-delivered` used to count here,
  // and it was the easiest of the four to write — so "if it is not delivered,
  // SMS the same day" satisfied half the requirement while saying nothing
  // about anyone who actually received the message. Undelivered is
  // `fallbackChannel` on the send: a real decision, worth stating, and not a
  // thing the journey branches on. It may still be mentioned; it no longer
  // counts towards the two.
  if (/not read|unread|does ?n[o']?t read|no read receipt|not opened|unopened|not seen|never saw|still sitting|sitting unread/.test(text))
    found.add('delivered-not-read');
  if (/read (it )?(and|but)|opened (it )?(and|but)|clicked (and|but)|read and no|ignore|no action|engaged but|took no|seen it and/.test(text))
    found.add('read-and-ignored');
  if (/delete|dismiss|binned|cleared the (chat|thread)/.test(text)) found.add('dismissed');
  if (/\bclicked\b|\btapped\b|\bopened the link\b/.test(text)) found.add('clicked');
  // CONVERTING IS NOT A LANDED CASE, and counting it was a hole in the same
  // lock: "still unread" plus "if they converted, we stop" cleared the gate
  // while the plan said nothing about anyone who read the message and did
  // not act. Whoever books is taken off the path by the Goal Check the
  // compiler inserts after every send — it is the platform's own terminal,
  // not a person who did something with this message and needs a next job.
  return found;
};

/**
 * THE JOURNEY MUST MOVE ON WHAT THE CUSTOMER DID.
 *
 * MEASURED, `eval/runs/ui-s-1792738033056`. The approved plan was a WhatsApp
 * drip on a fixed clock with a copy experiment on top. §7 has said EVEN
 * SPACING WITH NO REACTION IS NOT A PLAN for a day, in words, and the plan
 * shipped anyway — which is this repo's standing lesson about prompt rules.
 *
 * A clock treats unread, unreached and ignored as the same person. One of
 * those three never got the message, one is still deciding, and one has made
 * up their mind; sending all three the same reminder on day 3 is the campaign
 * declining to use the only information it has.
 *
 * TWO FAILURES OF THE SAME RULE, checked in order. The winner's declared
 * `journey` may be a clock — which is the claim — or it may say
 * branch-on-response while every touch falls back to the same reminder, which
 * is the claim without the thing. Neither is read off a blueprint here: there
 * is no blueprint at propose time, and `optionAudit` owns that job after
 * Confirm. A compiler-injected Goal Check after every send is NOT branching
 * and is deliberately invisible to this check, because the blueprint is the
 * source for that question and this is not it.
 */
export function reactionBlocks(p: ProposalUnderReview | null): Block[] {
  const s = p?.strategy;
  if (!s) return [];
  const chosen = (s.architectures ?? []).find((a) => a?.chosen);
  const journey = String(chosen?.journey ?? '').trim().toLowerCase();
  if (!chosen || !REACTIVE_JOURNEYS.includes(journey)) {
    return [
      {
        code: 'no-reaction',
        reason:
          'A clock that treats unread, unreached and ignored as the same person is not a plan. What happens next has to depend on what the customer did — delivered, read, acted — as far as the channel can tell you. A ticket-size split and a wording test are not that.',
        clears: {
          field: 'architecture',
          how: `Make the winner a candidate whose "journey" is ${REACTIVE_JOURNEYS.join(' or ')}. The rival it beats may be the clock — a statement-date or fixed-cadence plan is a legitimate alternative to weigh and reject. Do not invent a second customer problem to justify it.`,
        },
      },
    ];
  }
  if (namedOutcomes(s.touches ?? []).size < 2)
    return [
      {
        code: 'no-reaction',
        reason:
          'This plan says it reacts to the customer, and then every message does the same thing regardless: the person who never received it, the person who has not read it and the person who read it and did nothing all get the next reminder. Those are three different people.',
        clears: {
          field: 'touches',
          how: 'In "ifStillUnconverted", name at least two cases where the message LANDED and say what each one gets: delivered but still unread, read and no action taken, dismissed, or clicked without booking (email and RCS only). Undelivered is worth mentioning as the fallback channel on that send, but it is not one of the two — nobody who never received the message has done anything yet. Nor is converting: the goal check already takes anyone who booked off the path.',
        },
      },
    ];

  // AND THE STEPS HAVE TO DO IT, not just the essay.
  //
  // MEASURED, `ui-s-1792748248345`. The strategy declared branch-on-response
  // and named unread against read; the journey was a Transaction Amount
  // branch and three waits. Both halves came from the same model on the same
  // turn, so the prose above cannot stand in for the steps — and the manager
  // was shown Confirm, approved it, and the retry had to ask for the fork
  // after the fact. The moment to catch this is before the button appears.
  //
  // `journeyReacts` IS THE SAME FUNCTION THE BUILD TURN USES. One definition
  // of "the next step depends on what they did with the last message", read
  // twice, rather than a propose-time approximation that can drift from it.
  //
  // SILENT WHEN THE TURN CARRIES NO JOURNEY, deliberately. The propose turn
  // does not have one (see `ProposalUnderReview.blueprint`), and a block
  // whose only exit is a field the model has been told not to send is the
  // unclearable refusal this whole file exists to make impossible.
  if (p?.blueprint && !journeyReacts(p.blueprint)) {
    return [
      {
        code: 'no-reaction',
        reason:
          'The plan says the journey will move on what the customer did, and the steps are a timed sequence: nothing in them forks on whether the last message was delivered, read or dismissed. A split by ticket size is who they are, not what they did.',
        clears: {
          field: 'touches',
          how: 'Put ONE outcome fork on the send whose arms would do different jobs — usually the first touch, whose job is awareness: unread needs the same fact sooner, read-and-not-booked needs a different argument, dismissed needs leaving alone. Keep the who-split you have. Do not split after every send, and do not add a FAILED arm: undelivered is the fallback channel on the send.',
        },
      },
    ];
  }
  return [];
}

/** Channel words a plan may name, including inside a fallback sentence. */
const CHANNEL_WORDS: { key: string; re: RegExp }[] = [
  { key: 'whatsapp', re: /\bwhats ?app\b/ },
  { key: 'sms', re: /\bsms\b|\btext message\b/ },
  { key: 'email', re: /\be-?mail\b/ },
  { key: 'rcs', re: /\brcs\b/ },
  { key: 'inapp', re: /\bin-? ?app\b/ },
  { key: 'push', re: /\bpush\b/ },
];

/** The channel a touch is sent on, folded so WHATSAPP and "WhatsApp" are one. */
const channelKey = (channel: string | undefined): string => {
  const n = String(channel ?? '').trim().toLowerCase();
  if (!n) return '';
  return CHANNEL_WORDS.find((c) => c.re.test(n))?.key ?? n.replace(/[^a-z0-9]+/g, '');
};

/**
 * EACH CHANNEL IS A JOB, NOT A DEFAULT.
 *
 * WhatsApp for the catch while they are still in the moment is a job. SMS when
 * WhatsApp does not land is a job. Email when the message has to be read later,
 * or re-read, is a job. Using one channel for all of it while three others sit
 * unused is habit, and the live plan was four WhatsApp sends.
 *
 * NAMING A FALLBACK COUNTS, even when it has no row of its own. "If it is not
 * delivered, SMS the same day" gives SMS a job; the second channel does not
 * have to appear as a scheduled touch to be a decision rather than an
 * oversight. That is the only release here, and it reads the manager-facing
 * sentence the model already writes.
 *
 * THE OPPOSITE MISTAKE IS ALSO REFUSED. Firing every channel at the same
 * person on the same day is fatigue dressed as coverage. Different channels on
 * different days, or SMS only on the failure fork, is the shape wanted.
 */
export function channelJobBlocks(p: ProposalUnderReview | null): Block[] {
  const touches = p?.strategy?.touches ?? [];
  if (!touches.length) return [];
  const out: Block[] = [];

  const used = new Set(touches.map((t) => channelKey(t.channel)).filter(Boolean));
  if (touches.length >= 2 && used.size === 1) {
    const only = [...used][0];
    const fallbackText = touches.map((t) => String(t.ifStillUnconverted ?? '')).join(' ').toLowerCase();
    const namesAnother = CHANNEL_WORDS.some((c) => c.key !== only && c.re.test(fallbackText));
    if (!namesAnother) {
      out.push({
        code: 'single-channel-habit',
        reason: `Every message in this plan goes out on the same channel, and nothing says what the others are for. WhatsApp for the catch while they are still in the moment is a job; SMS for when that does not land is a job; email for a message they need to read later is a job. One channel for all of it, while the rest sit unused, is habit rather than a decision.`,
        clears: {
          field: 'touches',
          how: 'Give at least two channels a job — a different channel on a later day, or named in "ifStillUnconverted" as the fallback when the first does not land — or say in "approach" why the others cannot do this job. Do not fire every channel at everyone.',
        },
      });
    }
  }

  // Same person, same day, two channels. Keyed on path AND day, because
  // different channels on different days is exactly the shape wanted, and a
  // failure fork that re-sends on SMS the same day is a named path.
  const sprayed = new Map<string, Set<string>>();
  for (const t of touches) {
    const key = `${String(t.path ?? 'all').trim().toLowerCase()}@${t.day}`;
    const set = sprayed.get(key) ?? new Set<string>();
    const ch = channelKey(t.channel);
    if (ch) set.add(ch);
    sprayed.set(key, set);
  }
  const clash = [...sprayed.entries()].filter(([, set]) => set.size >= 2);
  if (clash.length) {
    out.push({
      code: 'channel-spray',
      reason: `This plan sends the same group two messages on two channels on the same day (${clash
        .map(([key, set]) => `day ${key.split('@')[1]}: ${[...set].join(' and ')}`)
        .join('; ')}). That is fatigue rather than coverage — the second one arrives before the first has had a chance to work.`,
      clears: {
        field: 'touches',
        how: 'Put the second channel on a different day, or on the failure fork only — reached when the first was not delivered — rather than alongside it.',
      },
    });
  }
  return out;
}

/**
 * Dimensions that could actually cut a journey by customer.
 *
 * Platform settings never reach the record (`recordDimensions` drops them),
 * and a timing finding is kept but is not an axis — see `isTimingDimension`.
 */
const segmentationDimensions = (brief: WorkingBrief) =>
  briefDimensions(brief).filter((d) => !isPlatformDimension(d.name) && !isTimingDimension(d.name));

/** A pattern the manager has SEEN, which is the only thing a cut may rest on. */
const seenAxes = (brief: WorkingBrief) =>
  segmentationDimensions(brief).filter((d) => d.basis === 'user' && d.status === 'retained');

/**
 * Has anyone asked whether there is a SECOND pattern?
 *
 * Three ways to be done, and all of them are evidence rather than effort:
 *
 *  - two or more segmentation dimensions carry `basis: 'user'`, so the
 *    manager has spoken about more than one axis whatever became of them;
 *  - one carries `basis: 'user'` with `deferred` or `unavailable` AND a note
 *    — "we do not track category" is an answer, and the note is where it
 *    lives;
 *  - a question that plainly asked it has been answered.
 *
 * What does NOT count: a dimension the agent invented and deferred on its
 * own. `basis: 'assumption'` is the agent talking to itself, and the live run
 * had two of those sitting under a heading that read like a search.
 */
export function otherAxesProbed(brief: WorkingBrief): boolean {
  const seg = segmentationDimensions(brief);
  if (seg.filter((d) => d.basis === 'user').length >= 2) return true;
  if (seg.some((d) => d.basis === 'user' && (d.status === 'deferred' || d.status === 'unavailable') && (d.note ?? '').trim()))
    return true;
  return (brief.questions ?? []).some(
    (q) =>
      q.addressedInRound !== undefined &&
      /\banything else\b|\bother pattern\b|\bany other\b|\bbesides\b|\belse have you seen\b/i.test(q.text ?? ''),
  );
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

  // ONE PATTERN IS A CANDIDATE, NOT THE ARCHITECTURE.
  //
  // MEASURED, `eval/runs/ui-s-1792738033056`. The manager named exactly one
  // thing they had seen — purchases above ₹10,000 convert more — plus a
  // barrier and a timing fact. The agent proposed on the spot and split the
  // whole journey on ticket size. It never asked whether anything ELSE had
  // been seen: not category, not first-time versus repeat, not card type.
  //
  // The record afterwards looked like a considered search — two retained
  // dimensions and two deferred ones — and was not. The second retained one
  // was a clock (`basis: 'tool'`), and both deferred ones were the agent's
  // own inventions marked `assumption`. **A dimension the agent raised and
  // set aside by itself is not a probe**; nobody was asked anything.
  //
  // So: ask once, then lock. Not a questionnaire — one question, and "we do
  // not track that" closes it for good. `otherAxesProbed` counts evidence,
  // never effort.
  //
  // DELIBERATELY NOT RAISED WHEN THERE IS NO SEEN AXIS YET. With nothing
  // retained from the manager, the existing who-converts block still owns the
  // conversation and two blocks asking adjacent questions would read as the
  // application talking over itself.
  //
  // It is a `blocksFor` block like its siblings, so `proceedRequested` and
  // the round budget release it, and an approved Confirm carries it as a
  // limitation rather than a refusal.
  if (
    convertersSettled(brief.converters) &&
    designableBarriers(brief.barriers).length > 0 &&
    seenAxes(brief).length === 1 &&
    !otherAxesProbed(brief)
  ) {
    out.push({
      code: 'unprobed-other-axes',
      reason: `You have given me one pattern you have seen — ${seenAxes(brief)[0].name}. Before I design around it, is there anything else you have noticed that splits who acts? If you do not track anything else, say so and I will go with this one.`,
      clears: {
        field: 'dimensions',
        how: 'Ask ONE question, and NAME one or two axes in it, derived from this objective — on an EMI-eligible-purchase campaign that is merchant category, first-time versus repeat, or card type. "Anything else?" with no noun is not a question anyone can answer. Accept "we do not track that" as a complete answer. Or record a second segmentation dimension with basis "user" — retained, deferred or unavailable with a note. A dimension you deferred yourself is not an answer.',
      },
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
    case 'architecture':
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
