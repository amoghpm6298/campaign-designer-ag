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
import { isPlatformDimension, probeWasAsked, recordDimensions, seenAxes, segmentationDimensions, CLOSED_OTHER_AXES, type WorkingBrief } from './discovery';
import { designableBarriers, convertersSettled, type Barrier, type Converters } from './findings';
import { journeyReacts } from './optionAudit';
import { whoGroups, hasExperiment, sendSteps, sendChannels, coSentPairs } from './pathReading';
import type { CampaignBlueprint } from './blueprint';
import { outstanding, exhausted } from './record';

// `MIN_DIMENSIONS` IS GONE. See the note in `blocksFor` where the block it
// fed was deleted: the brief is closed by evidence — a seen pattern and an
// answered probe — not by a count of rows.

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
    | 'dimension-unreasoned'
    | 'awaiting-reply'
    | 'belief-untested'
    | 'cadence-unnamed'
    | 'split-without-trend'
    | 'nothing-tested'
    | 'unprobed-other-axes'
    | 'stacked-dimensions'
    | 'no-reaction'
    // `chose-clock-over-reaction` WAS HERE and is advice now, not a block.
    // Describing a reactive rival and then picking the cadence is a judgement
    // a campaign manager is allowed to make; refusing their build over it is
    // the application choosing the campaign. The sentence still travels —
    // see `alignJourneyClaim`.
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
/**
 * IS THIS PATH APPROVABLE. The whole answer, in one place.
 *
 * Three things, and they are all about whether there is a campaign to agree
 * to rather than whether it is the campaign we would have written:
 *
 *  - `cadence-unnamed` — no shaped steps, no send anywhere in them, or a
 *    who-group the journey splits out and then never messages. Whoever lands
 *    there gets nothing at all, and a waits-only path reaches nobody.
 *  - `split-without-trend` — it cuts people on a factor nobody has said they
 *    have seen. KEPT DELIBERATELY: demoting this with `nothing-tested` would
 *    let a who-cut with no trend Confirm, which is the defect
 *    `eval/runs/ui-s-1793077922155` is about from the other side.
 *  - `no-reaction` — they CLAIMED a reacting journey and attached no shaped
 *    path. There is nothing to approve, not a difference of taste.
 *
 * EVERYTHING ELSE IS ADVICE, and this is the locked product: a clock plus a
 * who-split is a complete first campaign. Reaction is smarter, not mandatory.
 * So `nothing-tested`, `single-channel-habit`, `channel-spray`,
 * `stacked-dimensions` and `belief-untested` all still get said, next to a
 * live button.
 *
 * `nothing-tested` and `split-without-trend` are two outcomes of ONE function
 * and are split here rather than there, so the one place that decides what
 * holds is the one place to read.
 */
const PATH_HOLDS = new Set(['cadence-unnamed', 'split-without-trend', 'no-reaction']);

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
  // THE CLAIM IS ALIGNED TO THE STEPS BEFORE ANYTHING JUDGES IT.
  //
  // The steps are the plan. The chosen architecture's `journey` word is a
  // label on it, and when the two disagree the application can repair the
  // label — it cannot repair the path, and it must not hold a plan hostage to
  // its own vocabulary. Aligning here rather than at one call site means
  // every reader of `decide` sees the same proposal the manager would
  // approve: the orchestrator, a test, a replay of a recorded brief.
  const aligned = alignJourneyClaim(opts.proposed ?? null);
  const proposed = aligned.proposed;
  // TWO QUESTIONS, NOT ONE BIT.
  //
  // `blocksFor(brief)` answers IS DISCOVERY FINISHED. The plan checks answer
  // MAY THEY APPROVE THIS JOURNEY. They were summed into one list, so every
  // judgement about a plan had the same power as "there is no journey" — and
  // a channel-mix opinion kept the Confirm button off a campaign that was
  // ready to run. MEASURED, `eval/runs/ui-s-1793084077571` turn 4: a closed
  // brief, a ticket-size split with sends on both arms and a nested read fork,
  // held on `single-channel-habit` and shown Revise.
  //
  // So the plan checks still all RUN — the sentences are worth saying — and
  // only the ones in `PATH_HOLDS` can keep the button off. The rest travel as
  // advice beside it.
  const planChecks = opts.building
    ? proposalBlocks(brief, proposed)
    : [
        ...proposalBlocks(brief, proposed),
        ...cadenceBlocks(proposed),
        ...trendBlocks(brief, proposed),
        ...stackedDimensionBlocks(brief, proposed),
        ...reactionBlocks(proposed),
        ...channelJobBlocks(proposed),
      ];
  const blocks = [...blocksFor(brief), ...planChecks.filter((b) => PATH_HOLDS.has(b.code))];
  // The alignment's own sentences are ADVICE: true of the plan, worth saying,
  // never a reason to refuse. `building` keeps them too — a manager reading
  // the build summary is still owed "a read-fork would have been smarter".
  const advice = [
    ...adviceFor(brief),
    ...aligned.advice,
    ...planChecks.filter((b) => !PATH_HOLDS.has(b.code)).map((b) => b.reason),
  ];

  if (opts.proceedRequested) {
    return { proceed: true, blocks: [], advice: [...advice, ...blocks.map((b) => b.reason)], forcedBy: 'user' };
  }
  if (brief.rounds >= MAX_ROUNDS) {
    return { proceed: true, blocks: [], advice: [...advice, ...blocks.map((b) => b.reason)], forcedBy: 'budget' };
  }
  return { proceed: blocks.length === 0, blocks, advice };
}

/**
 * WHAT KIND OF TURN THIS IS. One fact, computed from one set of inputs, read
 * by everything that behaves differently on a discovery turn, a propose turn
 * and a build turn.
 *
 *   asking — may write the RECORD and may not write a PATH. No lookups, no
 *            journey grammar in any schema, and a proposal is refused by the
 *            record rather than by a missing field.
 *   ready  — may propose. Lookups travel, the grammar travels, a plan without
 *            its path is refused as a payload mistake.
 *   build  — the plan is approved and this turn compiles it.
 *
 * WHY THIS IS A FUNCTION AND NOT SEVEN EXPRESSIONS. Each reader used to
 * compute its own answer, and the inputs drifted: the schema asked
 * `decide(brief, { proceedRequested: limitReached })`, the handler asked
 * `decide(brief)` with no escape at all, and two more call sites passed only
 * `saysProceed(latestUserText)`. So a manager typing "go ahead" on a thin
 * record got a turn where `propose_strategy` carried `blueprint` and the
 * handler refused the payload for being sent on an unfinished record — the
 * schema and the handler contradicting each other, which is the shape of the
 * live wall in `eval/runs/ui-s-1792834072700` turn 3.
 *
 * `limitReached` is already the union of every escape: the round budget,
 * `forceProposal` from the button, and `saysProceed` on their latest message.
 * Anything that reads a narrower one is a second escape set, and a refusal
 * that outlives the instruction to stop refusing lives in the gap.
 *
 * EVALUATED PER MODEL ROUND, NOT ONCE PER TURN. Round one of a turn may file
 * the last finding the record needed, and round two of the SAME turn is then
 * genuinely ready to carry a path. Freezing this at the start of the turn
 * would file success and then hold the asking schema for the rest of it,
 * which is a one-round-late loop of exactly the kind this replaces.
 */
export type TurnPhase = 'asking' | 'ready' | 'build';

export function turnPhase(
  brief: WorkingBrief,
  opts: { isBuildTurn: boolean; limitReached: boolean },
): TurnPhase {
  if (opts.isBuildTurn) return 'build';
  return decide(brief, { proceedRequested: opts.limitReached }).proceed ? 'ready' : 'asking';
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
   * POPULATED ON EVERY REAL PROPOSAL, since 2026-10-23. `propose_strategy`
   * carries the path now and the tool refuses a plan without one, so a
   * reactive winner with no journey is a HOLD rather than a silence — the
   * exit is to send the steps. The previous comment here recorded the
   * opposite, and it was right at the time: on `ui-s-1792748248345` turn 4
   * the proposing turn carried `strategy` with `blueprint: false`, because
   * the tool had no slot for one and the prompt said the grammar was
   * omitted. That withhold is gone for the ready-to-propose turn and intact
   * for every asking turn.
   */
  blueprint?: CampaignBlueprint | null;
}

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

// `cutsPeople` AND `whoGroups` LIVE IN `pathReading` NOW, with the compiler
// and the propose boundary reading the same file. They were a third copy of a
// walk that had already disagreed with itself twice, and the last disagreement
// cost a live run: a ticket-size fork written as a `condition` produced no
// groups at all, because this version only ever iterated `step.paths` and a
// condition has `yes`/`no`.
//
// `sendsInside` went with them on 2026-10-27. It was `whoGroups`' own
// send-counter and was left behind when the walk moved, referenced only by its
// own recursive calls — which is why `noUnusedLocals` never reported it,
// though this project does set it. A self-recursive declaration counts as
// read, so an unused RECURSIVE helper is invisible to the one check that
// catches an unused plain one (measured: the plain sibling is flagged
// TS6133 and the recursive one is not). Worth knowing, because every walk in
// this codebase is recursive, so this is the shape of dead code the compiler
// will not hand us.
//
// `sendSteps` in `pathReading` is the counter now, and it is the one the
// compile check and the compiler agree on.
//
// Re-exported because the tests and `cadenceBlocks` both ask for it by name.
export { whoGroups };

/**
 * THE CADENCE RULE, read off the who-groups the steps create.
 *
 * The walk itself is `whoGroups` in `pathReading`; what stays here is why this
 * check asks it rather than reading `touches`, and what it does with the
 * answer.
 *
 * READ OFF THE PATH, NOT OFF `touches`, since 2026-10-26.
 *
 * MEASURED, `eval/runs/ui-s-1792984906680` turns 3 and 4. The journey was
 * complete — a ticket-size branch, a wording experiment on the smaller band,
 * a READ against DELIVERED/DELETED fork inside each arm, a last chance on
 * every tail, and day 0 / 2 / 5 on the band the campaign is for. The manager
 * got no Confirm, because `touches` described that journey as SIX paths:
 *
 *     "Below ₹10,000 — functional framing"
 *     "Below ₹10,000 — benefit framing"
 *     "Below ₹10,000 — read but no action (either framing)"
 *     "Below ₹10,000 — not read (either framing)"
 *     "Below ₹10,000 — all still unconverted"
 *     "₹10,000 and above"
 *
 * Counting each caption as a group demanded two sends per experiment arm and
 * per engagement arm, so a journey that over-DESCRIBES itself was refused for
 * under-dosing. The prose was never the sequence.
 *
 * A WHO-GROUP IS A BRANCH ON A CUSTOMER OR TRANSACTION ATTRIBUTE — ticket
 * size, category — because that is a group of people. Experiment arms are
 * INTERIORS of a group: the same people, split at random. Engagement arms
 * (`statuses`) are interiors too: the same person, later. Neither is a
 * guest list.
 *
 * ONE SEND PER GROUP IS APPROVABLE. That is the standing product lock: a
 * who-split plus a clock is a complete first campaign, and forcing a
 * mid-window and a last chance onto every band is the application writing the
 * sequence. What is NOT approvable is a group with nothing to send it.
 */
export function cadenceBlocks(proposed: ProposalUnderReview | null): Block[] {
  if (!proposed?.strategy) return [];
  const path = proposed.blueprint ?? null;

  // NOTHING TO APPROVE IS THE ONLY HOLD LEFT.
  //
  // Two shapes qualify, and neither is a judgement about dosage:
  //
  //  - no shaped steps at all. "A staggered multi-touch sequence over the full
  //    14 days" is not a sequence anyone can approve, and that is measured:
  //    the manager approved a cadence they could not see and the build turn
  //    invented it from the sentence.
  //  - a who-group the journey cuts out and then never messages. The split
  //    put those people in their own lane and left the lane empty.
  //
  // A HOLDOUT IS NOT THAT. `whoGroups` reads the steps, and a deliberately
  // unmessaged control arm is an `experiment` arm — an interior — so it never
  // appears here as a group with no send.
  if (!shapedBlueprint(path)) {
    return [
      {
        code: 'cadence-unnamed',
        reason:
          'This plan does not say what actually goes out. "Multi-touch" is not a sequence a campaign manager can approve — send the journey itself: the entry, then the steps in order.',
        clears: {
          field: 'touches',
          how: 'Put the journey in "blueprint": the entry, then every step in order. Confirm compiles exactly that path, so it is what they are agreeing to.',
        },
      },
    ];
  }
  // AT LEAST ONE SEND IS IN THE PLAN. A path of waits and exits is shaped
  // grammar that reaches nobody, and `propose_strategy` refuses it before it
  // files — but `decide` is also called on replays and on a brief whose stash
  // predates that check, and demoting `nothing-tested` to advice removed the
  // only other thing that would have held one. This is the hold, in the file
  // that already owns "who gets nothing".
  //
  // `sendSteps` COUNTS SEND OBJECTS IN THE JSON, not compiled SEND nodes —
  // the same reading the tool's waits-only refusal uses. So this catches a
  // plan that never wrote a message, and NOT a plan whose messages all failed
  // to compile: that is the tool's 0-SEND-after-resolve refusal, which runs
  // the real compiler and counts nodes. Two different questions, deliberately,
  // and the gate is not a second compiler.
  if (sendSteps(path!.steps as unknown[]) === 0) {
    return [
      {
        code: 'cadence-unnamed',
        reason:
          'Nothing in this journey sends a message. The steps are real steps, but a path of waits and exits reaches nobody, and Confirm compiles exactly this path.',
        clears: {
          field: 'touches',
          how: 'Put the sends into the path, each one on the arm it belongs to.',
        },
      },
    ];
  }
  const empty = whoGroups(path!.steps as unknown[]).filter((g) => g.sends === 0);
  if (!empty.length) return [];
  return [
    {
      code: 'cadence-unnamed',
      reason: `${empty
        .map((g) => `"${g.label}"`)
        .join(' and ')} ${empty.length === 1 ? 'is a group this journey splits out and then never messages' : 'are groups this journey splits out and then never messages'}. Whoever lands there gets nothing at all.`,
      clears: {
        field: 'touches',
        how: 'Give that arm at least one send, or drop the split so those people stay on the main path. One send per group is enough — a who-split with a steady sequence is a complete campaign.',
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
  // THE STEPS ARE THE PLAN, AND THE STEPS ARE WHAT THIS READS.
  //
  // MEASURED, `eval/runs/ui-s-1793016334376`. Three turns, Confirm never
  // appeared. Turn 3 filed exactly the campaign this product wants: one
  // WhatsApp at purchase, then a read-versus-unread fork, a last chance on day
  // 6 on both arms. Five sends, copy, channels, stage. `brief.lastBlocks` was
  // `['split-without-trend']` and the bubble ended "This plan gives different
  // groups different messages, and nothing you have told me says those groups
  // behave differently."
  //
  // The "groups" were `Unread path` and `Read path` — NAMES IN `touches`, not
  // people. This function counted any path that was not "all"; `cadenceBlocks`
  // had known the difference since 2026-10-26, through `cutsPeople`. One
  // definition now answers it for both: a branch with `statuses` and no
  // attribute is the same person later, and an experiment arm is an interior.
  //
  // It is not fixed by filing the manager's "10k txns convert more" as a
  // trend. That would have released the WRONG hold — treating a read/unread
  // fork as a ticket-size cut — and 10,000 was the size of the eligible pool
  // rather than a pattern in who acts.
  const groups = whoGroups(p?.blueprint?.steps as unknown[] | undefined);
  // ARMS ARE NOT A CUT, AND A TEST DOES NOT EXCUSE ONE.
  //
  // An experiment arm is a treatment variant assigned at random, and an
  // outcome fork is the same person judged on what they did with the last
  // message. Neither makes a claim about who these people are, so neither
  // needs a trend behind it. A branch on a customer or transaction attribute
  // does make that claim, and needs one.
  //
  // `whoGroups` IS WHAT DECIDES, AND IT READS THE STEPS. The old rule read the
  // NAMES instead — any `touches[].path` that was not "all" counted, released
  // only when the plan declared an experiment, did not claim segmentation, and
  // no path echoed a recorded factor. That inferred people from labels, which
  // is how `Unread path` and `Read path` became an illegal who-split on
  // `eval/runs/ui-s-1793016334376`. None of that scoring survives: the shape
  // of the branch answers it, and `cadenceBlocks` asks the same function.
  //
  // A CLAIM CANNOT INVENT A CUT THE STEPS DO NOT HAVE, and cannot excuse one
  // they do. `Segmentation: used` on `strategyOptions` is the agent's verdict
  // on its own plan — and that field is taught by no manual, so its absence
  // says nothing either way. A declared wording test still does not legalise a
  // prior-EMI copy split: if the branch is there, the hold is there.
  const customerCut = groups.length > 0;

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

  // A CLOCK THAT COMPARES NOTHING, read off the steps as well.
  //
  // This used to fire on `verdict('experiment') !== 'used'`, so the live plan
  // above would have been held a second time for omitting a field no manual
  // teaches — after its first hold was lifted. A journey that reacts to what
  // the customer did IS comparing something: unread against read is the
  // reading. So the hold is for a plan that cuts nobody, runs no experiment in
  // its steps, and does not react.
  // THE SAME WALK AS THE COMPILER'S, from `pathReading`. This was a fourth
  // copy, written inline here a slice ago.
  const runsATest = hasExperiment(p?.blueprint?.steps as unknown[] | undefined);
  const comparesNothing = !runsATest && !journeyReacts(p?.blueprint ?? null);

  if (comparesNothing) {
    const parked = (s.hypotheses ?? []).length > 0;
    return [
      {
        code: 'nothing-tested',
        reason: parked
          ? 'Nobody can say yet who responds, and this plan keeps its test for a future run. There is no later run to inherit it: with nothing compared this time, the next campaign starts exactly as blind as this one.'
          : 'Nobody can say yet who responds, and this plan compares nothing, so it will return one number with nothing to read it against. The first run is where the signal comes from.',
        clears: {
          field: 'experiment',
          how: 'Run one comparison this time, in the PATH — two arms of an experiment on the wording, dosage, channel or timing this objective is actually uncertain about, or a fork on what the last message did so unread and read get different next jobs. Say in "measurement" what result would tell you which. A field on the options list is not the test; the steps are.',
        },
      },
    ];
  }
  return [];
}

/** The two journey behaviours in which the NEXT step depends on the customer. */
const REACTIVE_JOURNEYS = ['branch-on-response', 'wait-for-event'];

const claimsReaction = (a?: { journey?: string } | null): boolean =>
  REACTIVE_JOURNEYS.includes(String(a?.journey ?? '').trim().toLowerCase());

/**
 * A path a manager could actually be shown and approve.
 *
 * One step is enough, and the count is NOT the question — the live plan's
 * `steps` array held a single `branch` carrying eight nested sends, and the
 * accept message called it "a 1-step path". What matters is that every
 * element is a step object rather than a sentence, because Confirm compiles
 * these and `buildFromBlueprint` dies on a caption.
 */
export const shapedBlueprint = (bp: CampaignBlueprint | null | undefined): boolean =>
  !!bp &&
  Array.isArray(bp.steps) &&
  bp.steps.length > 0 &&
  bp.steps.every((s) => !!s && typeof s === 'object' && typeof (s as { kind?: unknown }).kind === 'string');

/** One sentence, offered once. Never a question, never a block. */
export const READ_FORK_ADVICE =
  'A read-fork on the first WhatsApp would treat unread and read as different jobs: the person who has not opened it needs the same fact sooner, and the person who read it and did nothing needs a different argument.';

/**
 * THE STEPS ARE THE PLAN. A `journey` label that disagrees with them is
 * repaired here, not held.
 *
 * MEASURED, `eval/runs/ui-s-1792843757296` turn 3. Discovery was finished,
 * `decide(brief)` was empty, the turn was ready, and `propose_strategy`
 * accepted a real path: a ticket-size branch, an experiment on the smaller
 * band, and inside it an outcome fork on READ against DELIVERED/DELETED.
 * `journeyReacts` on that blueprint is TRUE. Confirm never appeared anyway,
 * the response carried `pendingBlueprint: null`, and the manager read the
 * essay plus a hold saying the journey does not react — because
 * `reactionBlocks` returned on `namedOutcomes` over the touch PROSE before it
 * ever looked at the steps. Vocabulary beat the path.
 *
 * Three cases, and only the last one is a hold:
 *
 *  - the steps react: the claim is true, keep it;
 *  - the steps are a who-split and a clock: a reaction claim is rewritten to
 *    `linear` so the plan matches the path, and the read-fork sentence goes
 *    out as advice. No fork is invented and the who-split is untouched;
 *  - there is no shaped path at all: nothing is repaired, because there is
 *    nothing to approve but a paragraph. `reactionBlocks` holds that one.
 */
export function alignJourneyClaim(p: ProposalUnderReview | null): {
  proposed: ProposalUnderReview | null;
  advice: string[];
  /** The claim was rewritten to match the steps. */
  stripped: boolean;
} {
  const s = p?.strategy;
  if (!p || !s) return { proposed: p, advice: [], stripped: false };

  const path = p.blueprint ?? null;
  const shaped = shapedBlueprint(path);
  const reacts = shaped && journeyReacts(path as CampaignBlueprint);
  const before = s.architectures ?? [];
  const chosen = before.find((a) => a?.chosen);

  // A FALSE CLAIM BECOMES A CADENCE CLAIM. `linear` is what the plan actually
  // is: everyone eligible enters, the ticket-size split still decides which
  // treatment they get, and the sequence runs on a clock. Nothing else about
  // the architecture is touched.
  const stripped = shaped && !reacts && claimsReaction(chosen);
  const architectures = stripped ? before.map((a) => (a === chosen ? { ...a, journey: 'linear' } : a)) : before;
  const proposed: ProposalUnderReview = stripped ? { ...p, strategy: { ...s, architectures } } : p;

  const advice: string[] = [];
  // Said when the path is a clock, whether the model claimed otherwise or
  // not. It is the better campaign and the manager should hear so once.
  if (shaped && !reacts) advice.push(READ_FORK_ADVICE);
  // AND THE RIVAL THEY BEAT. This was a Block (`chose-clock-over-reaction`)
  // and is advice now: writing both candidates and picking the cadence is a
  // judgement a manager is allowed to make.
  const winner = architectures.find((a) => a?.chosen);
  if (!claimsReaction(winner)) {
    const rival = architectures.find((a) => claimsReaction(a) && a !== winner);
    if (rival) {
      advice.push(
        `You described a version of this that treats someone who opened the message and someone who never did as two different people — "${String(
          rival.journey,
        )}" — and then chose the one that goes by the calendar. The reacting one is usually the better campaign.`,
      );
    }
  }
  return { proposed, advice, stripped };
}

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
export const namedOutcomes = (touches: { ifStillUnconverted?: string }[]): Set<string> => {
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

  // ONE READER: THE STEPS.
  //
  // A CLOCK IS A COMPLETE PLAN, and that reversal stands: the measured
  // failure was a plan that CLAIMED a reaction and shipped a timed drip, not
  // a cadence as such. A ticket-size split with a sensible sequence is a
  // campaign a manager can run on Monday.
  //
  // WHAT CHANGED 2026-10-26: this function used to return on
  // `namedOutcomes(s.touches).size < 2` — the touch PROSE — before it read
  // `p.blueprint` at all. Measured on `eval/runs/ui-s-1792843757296` turn 3:
  // the steps forked on READ against DELIVERED/DELETED, `journeyReacts` was
  // true, and Confirm still never appeared because `ifStillUnconverted` named
  // one landed case. `namedOutcomes` is a summariser for touch lists and
  // `channelJobBlocks` still uses it; it is not the Confirm gate.
  //
  // So there is exactly ONE way left to be held here, and it is the one with
  // nothing to approve: a plan that says the journey moves on what the
  // customer did, with no journey attached. Everything else — a true claim, a
  // claim `alignJourneyClaim` has already rewritten to match a clock, or a
  // cadence that never claimed otherwise — proceeds, and the read-fork
  // sentence goes out as advice instead.
  if (!claimsReaction(chosen)) return [];
  if (shapedBlueprint(p?.blueprint)) return [];
  return [
    {
      code: 'no-reaction',
      reason:
        'This plan says the journey will move on what the customer did, and there is no journey attached to it — so there is nothing for them to approve except the description of one.',
      clears: {
        field: 'touches',
        how: 'Send the same plan again with "blueprint" filled in: the entry, then the steps in order, with ONE outcome fork on the send whose arms would do different jobs. Confirm compiles exactly that path, so it is what they are agreeing to.',
      },
    },
  ];
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

  // HABIT IS READ OFF THE STEPS, NOT OFF `touches[].channel`.
  //
  // MEASURED, `eval/runs/ui-s-1793084077571` turn 4. Every send carried
  // `channelPreference: ['WHATSAPP','SMS']` AND `fallbackChannel: 'SMS'` — SMS
  // had a job on every message — and the plan was accused of being single
  // channel, because this counted one string per touch row and the model had
  // written the same one four times: "WhatsApp (SMS fallback on delivery
  // failure)". One distinct string, so one channel, so habit. The row even
  // said SMS; only the thing being counted disagreed.
  //
  // Reading `ifStillUnconverted` for another channel name was the patch for
  // that, and it is prose: it releases on a sentence and accuses on a silence.
  // The steps are the plan, so the steps answer it. This is advice now either
  // way — it cannot keep the button off — which is exactly why it must not be
  // a false accusation sitting beside a live Confirm.
  const inSteps = sendChannels(p?.blueprint?.steps as unknown[] | undefined);
  const used = inSteps.size ? inSteps : new Set(touches.map((t) => channelKey(t.channel)).filter(Boolean));
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
  // SPRAY IS READ OFF THE STEPS TOO, for the same reason habit is.
  //
  // The touch-table version keys on `path` + `day` and escapes through an
  // `ifStillUnconverted` prose check. Two EXCLUSIVE ARMS written under one
  // path name are two rows, one path, one day — so it fires, and the escape
  // only clears it if the model happened to describe each arm's landed case in
  // the right field. Nobody receives both messages; the table cannot see that
  // and the steps can.
  //
  // `coSentPairs` compares only sends one customer actually receives together:
  // adjacent with nothing between them that passes time, or both declaring the
  // same `delayDays`. Sibling arms are never compared. Advice either way — it
  // cannot keep the button off — which is exactly why it must not accuse from
  // a table the steps disprove.
  const steps = p?.blueprint?.steps as unknown[] | undefined;
  if (steps?.length) {
    const together = coSentPairs(steps).filter(
      (pair) => pair.a.size && pair.b.size && [...pair.a].some((c) => !pair.b.has(c)),
    );
    if (together.length) {
      const named = [...new Set(together.map((t) => `${[...t.a].join('/')} and ${[...t.b].join('/')}`))].slice(0, 3);
      out.push({
        code: 'channel-spray',
        reason: `This journey sends the same person two messages at the same point on different channels (${named.join('; ')}). That is fatigue rather than coverage — the second arrives before the first has had a chance to work.`,
        clears: {
          field: 'touches',
          how: 'Put a wait between them, or put the second one on an ARM of a fork so one person gets one message — the one who has not read the first on one channel, the one who has read it on another.',
        },
      });
    }
    return out;
  }

  const sprayed = new Map<string, { channels: Set<string>; rows: typeof touches }>();
  for (const t of touches) {
    const key = `${String(t.path ?? 'all').trim().toLowerCase()}@${t.day}`;
    const cell = sprayed.get(key) ?? { channels: new Set<string>(), rows: [] };
    const ch = channelKey(t.channel);
    if (ch) cell.channels.add(ch);
    cell.rows.push(t);
    sprayed.set(key, cell);
  }
  // EXCLUSIVE ARMS ARE NOT TWO MESSAGES TO ONE PERSON.
  //
  // MEASURED, `ui-s-1792829868203` turn 5: day 2 carried an SMS for the
  // person who had not read the first message and a WhatsApp for the person
  // who had, both on "Standard ticket" — ONE fork, and nobody receives both.
  // Counting them as fatigue sent the manager back to rename paths, which is
  // how they ended up clerking DELIVERED by hand.
  //
  // Read off the rows themselves: two rows naming DIFFERENT landed cases are
  // the two sides of one fork. The same sentence on both means both would
  // fire, which is the real thing this block is for.
  const exclusiveArms = (rows: typeof touches): boolean => {
    const cases = rows.map((r) => [...namedOutcomes([r])].sort().join('+')).filter(Boolean);
    return cases.length >= 2 && new Set(cases).size === cases.length;
  };
  const clash = [...sprayed.entries()]
    .filter(([, cell]) => cell.channels.size >= 2 && !exclusiveArms(cell.rows))
    .map(([key, cell]) => [key, cell.channels] as const);
  if (clash.length) {
    out.push({
      code: 'channel-spray',
      reason: `This plan sends the same group two messages on two channels on the same day (${clash
        .map(([key, set]) => `day ${key.split('@')[1]}: ${[...set].join(' and ')}`)
        .join('; ')}). That is fatigue rather than coverage — the second one arrives before the first has had a chance to work.`,
      clears: {
        field: 'touches',
        how: 'Put the second channel on a different day, or on one ARM of a fork, so one person gets one message that day — the one who has not read the first message on one channel, the one who has read it on another. If they are already exclusive arms, say which landed case each row is for in "ifStillUnconverted": unread and read-with-no-action are two different people, not two sends to the same one.',
      },
    });
  }
  return out;
}

// `segmentationDimensions` and `seenAxes` MOVED TO discovery.ts, 2026-10-24,
// and are imported above. `noteClosedOtherAxes` needs the same two rules to
// decide which dimensions a manager's "nothing else" closes, and a second
// copy of them is how this file's own history says things drift. Platform
// settings never reach the record (`recordDimensions` drops them), and a
// timing finding is kept but is not an axis — see `isTimingDimension`.

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
  // A QUESTION WE ASKED AND THEY ANSWERED. Both legs of that live in
  // `probeWasAsked` — the phrase one and the structural one that reads the
  // axis names off the brief — because `noteClosedOtherAxes` needs the same
  // answer and a second copy of this rule is how the two would drift.
  if (probeWasAsked(brief)) return true;

  // A FOURTH WAY, AND IT IS THE ONE THE MANAGER ACTUALLY USES: they said so in
  // chat, and `noteClosedOtherAxes` wrote it down as a confirmed fact.
  //
  // The three above read dimensions and question text, and a conversation is
  // neither — so the taught answer ("We do not track that") could be given,
  // recorded in prose, and still leave this false. Evidence rather than
  // effort, like the others: the fact exists only because their own sentence
  // closed the question, and the quote is in it.
  return (brief.facts ?? []).some((f) => f.statement.startsWith(CLOSED_OTHER_AXES));
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
  // `too-few-dimensions` IS GONE, 2026-10-26, and the number went with it.
  //
  // It counted RAISED lines of enquiry — three — and a count is not a search.
  // Last week it was narrowed to skip once a seen axis plus an answered probe
  // existed, which was the right instinct and the wrong shape: the condition
  // it was narrowed by IS the whole rule. `unprobed-other-axes` above already
  // asks it, in evidence rather than tally, and refuses to be satisfied by a
  // row the agent deferred on its own.
  //
  // MEASURED, `eval/runs/ui-s-1792984906680`. Two real rows — the ticket size
  // they described, and the purchase channel the agent filed as its own
  // `assumption` — a finished record, and a real journey on file. The third
  // angle had nowhere to come from except invention, and `evaluateDiscovery`
  // was saying the same thing from its own copy of the rule: "I have only
  // looked at 2 angle(s) so far", twice, with no question attached.
  //
  // An unreasoned drop is still a block — that is the next rule down, and it
  // is about a decision nobody explained rather than about a quantity.

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
      // ENOUGH TO CLEAR ANY DIMENSION BLOCK, whichever one is live. The count
      // this used to subtract from (`MIN_DIMENSIONS`) is gone with the block
      // that read it; what remains to satisfy is an unreasoned drop and the
      // second-pattern probe, both of which care about WHAT a row says rather
      // than how many there are.
      const add = realistic.slice(0, Math.max(0, 3 - dims.length)).map((d) => ({
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
