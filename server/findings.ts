// What the agent learned about the customers, as opposed to what it learned
// about the platform.
//
// THE DEFECT THIS FIXES. Across 35 recorded runs the agent never once asked
// why customers do not convert, or which customers already do. It asked
// instead about KYC completeness, DNC lists, account standing and whether a
// prior EMI Request exists. Those are not failures of tone — they were the
// only kind of thought available to it. Everything it is given is operational:
// a catalogue of attributes it may filter on (ELIGIBILITY_META), constraints
// it must not break (bank-context.json), how the builder works, and eleven
// principles of which not one concerns why a customer converts. Asked to
// raise conversion, audience plumbing is the only thing it CAN reason about.
//
// So this module adds the two things that were missing, and adds them as
// REQUIRED AND EMPTY rather than as content:
//
//   converters — who converts today. There is no performance data anywhere in
//                this prototype, so the campaign manager's own anecdote is
//                the only evidence that exists.
//   barriers   — why everyone else does not.
//
// WHY NOTHING IS SEEDED. An earlier version of this shipped five candidate
// barriers for OS-to-EMI (cost perception, unawareness, tenure confusion,
// distrust, inertia), marked unverified, on the argument that the agent needs
// something to reason with on turn one. That was wrong twice over. A
// candidate list turns discovery into multiple choice: the agent
// pattern-matches what the manager said onto the nearest listed option
// instead of listening. And it caps the answer at whatever the list's author
// thought of, so a real barrier outside it — the EMI option buried three
// screens deep, relationship managers steering customers away on incentives —
// gets forced into the closest available bucket. Working out the reason IS the
// job. An empty required slot is a question generator; a filled one removes
// the task.
//
// Together the two findings also produce the two strategies worth comparing,
// which the prompt has asked for since the architectures block was written and
// never meaningfully received: double down on the people who resemble today's
// converters, or expand by attacking what stops everyone else.

/**
 * What a finding about customers rests on.
 *
 * Deliberately has no 'tool' member, unlike `DimensionBasis` which extends
 * this with one. Nothing in this system can report why a customer behaved as
 * they did — there is no analytics access, and the knowledge base says so
 * outright (`Historical learnings: NONE AVAILABLE`). A barrier claiming to
 * rest on a tool would be a claim the prototype cannot support, so the type
 * does not offer the option.
 *
 *  user        — the manager stated it as something they know. Their own
 *                book: "mostly large-ticket purchases", "about 40% is
 *                eligible at any time".
 *  user-belief — the manager's explanation of WHY customers behave as they
 *                do. A conjecture they cannot actually verify, however
 *                confidently it was put. "my guess is they see the interest
 *                and think it is too expensive."
 *  assumption  — the agent's own, with nothing behind it.
 *  none        — nothing yet.
 */
export type FindingBasis = 'user' | 'user-belief' | 'assumption' | 'none';

/** Whether anyone can say who converts today. See `Converters.knowledge`. */
export type ConverterKnowledge = 'known' | 'none-yet' | 'unknown';

/** What a barrier can be attacked with, if anything. */
export type BarrierLever = 'message' | 'timing' | 'targeting' | 'not-addressable';

/**
 * Who converts today, in the manager's own words.
 *
 * `shape` is deliberately free text and deliberately not an attribute
 * expression. The point is to capture "mostly people who already called the
 * helpline" faithfully, including when it maps to nothing the builder can
 * filter on. Turning it into an attribute is a later, separate step, and
 * doing it too early is how the intended audience quietly became the
 * buildable one.
 */
export interface Converters {
  shape: string;
  basis: FindingBasis;
  /**
   * Which situation this is. The three are genuinely different campaigns, and
   * collapsing them was a real defect in the first version of this module:
   * `convertersSettled` accepted "they have no data on this" as an answer and
   * let the agent proceed, so the one case where it needed to think hardest
   * was the case it was allowed to skip.
   *
   *  known     — the manager described them. The campaign can target that
   *              profile (double down) or go after everyone else (expand).
   *  none-yet  — a fresh campaign; nobody has converted yet, so there is no
   *              profile to describe and none can be invented.
   *  unknown   — conversions happen, but nobody can say who converts.
   *
   * For the last two there is nothing to double down on, so the campaign's
   * job changes: it has to FIND OUT who converts. That is a real, well-formed
   * design — an audience test, or segments treated differently and compared —
   * not a blocked state.
   */
  knowledge: ConverterKnowledge;
  /**
   * Segments the agent proposed, with its reasoning, when nobody knew.
   *
   * Required in the `none-yet` and `unknown` cases, and at least two of them:
   * one candidate is a guess dressed as analysis, two or more is a set of
   * options the manager can actually react to, argue with, or rule out. Same
   * reasoning as requiring two candidate architectures rather than one.
   */
  candidates?: {
    /** The group, named as the manager would say it. */
    segment: string;
    /**
     * What defines this group: the attribute or behaviour it rests on.
     *
     * Declared SEPARATELY from the reasoning so the application can check
     * that the candidates are actually a choice, without judging what any of
     * them mean. Two groups resting on the same thing are two names for one
     * group, and offering them is not offering an option. This is the same
     * shape as an experiment declaring what it tests and the application
     * checking the arms really differ.
     *
     * Deliberately NOT validated against the attribute catalogue. A real
     * segment may rest on something the platform cannot filter on, such as
     * "called the helpline last month", and that is worth discussing before
     * it is worth building.
     */
    restsOn: string;
    /** Why that makes this group more likely to convert. The mechanism. */
    why: string;
  }[];
  /**
   * The round the candidates were put to the manager.
   *
   * Exists so "the agent proposed segments" can be told apart from "the
   * manager had a chance to respond to them" — the agent must not propose a
   * target and immediately treat its own suggestion as agreed.
   */
  raisedInRound?: number;
}

/** One reason customers do not convert. */
export interface Barrier {
  /** Stable id so an intervention can cite it. */
  id: string;
  /** The reason, as a sentence. */
  statement: string;
  basis: FindingBasis;
  lever: BarrierLever;
  /**
   * The manager's own words this rests on, when the basis claims they said
   * it. This is what makes the attribution CHECKABLE rather than asserted.
   *
   * Without it, `basis: 'user-belief'` is just a label the model can apply to
   * its own invention, and there is no way to tell a reason the manager gave
   * from one the agent made up and credited to them. The application verifies
   * this quote against what the manager actually typed and downgrades the
   * basis to 'assumption' when it does not match — see
   * `recordBarriers` in server/discovery.ts. A downgrade is not an error: it
   * is the record correcting itself, and the agent sees it next round.
   */
  quote?: string;
}

/**
 * May a design be built on this barrier?
 *
 * Only if it traces to something the manager actually said. An
 * agent-invented barrier is a guess dressed as a finding, and a campaign
 * resting on one is the exact failure that required stripping
 * `Milestone Progress %` and `Engagement Tier` out of the app: plausible,
 * useful-looking, and backed by nothing.
 *
 * `user-belief` qualifies even though it is unverified, because a barrier is
 * almost always a belief — the manager cannot know why customers behave as
 * they do. What matters is that a PERSON offered it, not that it is proven.
 * Carrying it as a belief and testing it is the honest path; inventing one is
 * not.
 */
/** The barriers a proposal is allowed to cite. */
export const designableBarriers = (bs: Barrier[] | undefined): Barrier[] =>
  (bs ?? []).filter(isDesignable);

export const isDesignable = (b: Barrier): boolean =>
  b.basis === 'user' || b.basis === 'user-belief' || b.basis === 'assumption';

/**
 * Must this campaign TEST its barriers rather than act on them as settled?
 *
 * True when nothing the manager said supports any of them — every barrier is
 * the agent's own reading.
 *
 * THE DEADLOCK THIS REPLACES. 'assumption' used to be undesignable outright,
 * on the reasoning that no campaign should rest on something the agent made
 * up. That is right about PRESENTATION and wrong about PROGRESS: a manager
 * who genuinely does not know why customers behave as they do is the ordinary
 * case, not an error, and refusing to design for them blocks for ever. When
 * there are no facts, the honest move is a strong assumption, stated as one,
 * and a campaign built to find out whether it holds.
 *
 * So an assumption may drive a design. What it may not do is pass as a
 * finding: `mustTestBarriers` is true, and the built journey has to be able
 * to tell the candidates apart — the same obligation `mustLearnAudience`
 * places on a campaign that cannot say who converts.
 */
export const mustTestBarriers = (bs: Barrier[] | undefined): boolean => {
  const usable = designableBarriers(bs);
  return usable.length > 0 && usable.every((b) => b.basis === 'assumption');
};

/**
 * Barriers THE MANAGER RAISED that the agent may not quietly ignore.
 *
 * Two exclusions, and they are different kinds of thing.
 *
 * `not-addressable` has been ANSWERED — with "a drip campaign cannot fix
 * this", which is a legitimate answer and one the agent previously had no way
 * to give. A barrier it simply did not act on has not.
 *
 * `assumption` was never the manager's, and that is the fix for a live
 * failure. Confirm refused with "You told me: Customers may notice individual
 * eligible-purchase pings but tune out…" — a rival theory the AGENT had
 * named, quoted back to the manager as their own words, blocking a build they
 * had approved. An invented barrier is a hypothesis worth testing; it is not
 * a promise anyone made.
 *
 * This does NOT weaken the design rules around assumptions. `isDesignable`
 * still admits them, so a campaign may be built on one, and `mustTestBarriers`
 * still requires the journey to TEST them when they are all it has. What
 * changes is only that the application stops attributing them to the manager.
 */
export const mustBeAddressed = (bs: Barrier[] | undefined): Barrier[] =>
  designableBarriers(bs).filter((b) => b.lever !== 'not-addressable' && b.basis !== 'assumption');

/**
 * Has the agent established who converts today?
 *
 * "They do not know" counts as established, which is why this checks the
 * basis rather than whether `shape` reads as informative. A manager who
 * genuinely has no idea has answered the question, and refusing to accept
 * that answer would be the questionnaire behaviour the prompt already warns
 * against. What does NOT count is the agent deciding for itself.
 */
export const convertersSettled = (c: Converters | null | undefined): boolean => {
  if (!c) return false;

  // THE MANAGER DESCRIBED THEM, and `knowledge` does not get a veto over that.
  //
  // Measured on the activation run, 2026-10-22, turn 3. They had said: treat
  // every newly issued card that has not transacted as one group, one track,
  // do not split. The record held it faithfully — shape exactly that, basis
  // `user` — and wrote `knowledge: 'none-yet'`, which is also a fair reading:
  // nobody can point at a sub-group that activates faster. Both statements are
  // true at once. The gate then took the second one, fell through to the
  // candidate path with zero candidates, refused the proposal, and told them
  // "I do not yet know who does this today, so I cannot say who the campaign
  // should go after" — about an audience they had just defined in one
  // sentence, and then asked again who converts.
  //
  // `knowledge` answers "can anyone say who converts faster today". The
  // AUDIENCE question is "who is this campaign for", and a user-stated shape
  // answers it whichever way the first one went. Keying on `knowledge` made
  // the answer depend on which of two true things the model wrote down.
  //
  // The protection the old ordering was reaching for is unchanged:
  // `mustLearnAudience` is still true whenever `knowledge !== 'known'`, so a
  // campaign that cannot say who converts still has finding out as part of its
  // job. It is now carried as a limitation rather than a refusal, which is the
  // right place for it — see the audience-coverage entry in server/CLAUDE.md.
  if (c.basis === 'user' && c.shape.trim().length > 0) return true;

  // Nobody knows AND they did not describe the audience either, which is where
  // the work actually is.
  //
  // THE DEFECT THIS FIXES. The first version returned true here on the
  // strength of `basis: 'user'` and any non-empty text, so "they have no data
  // on this" closed the question and the agent went straight to a design with
  // no view at all on who it was for. "We cannot know" is a fact about the
  // data, not an answer about the audience.
  //
  // THE RESIDUAL, STATED RATHER THAN HIDDEN. The user-shape clause above does
  // accept `basis: 'user'` plus any non-empty text, so a shape that merely
  // reports the absence — "nobody can say who converts" and nothing else —
  // settles this finding with no candidates. That is the old hole, narrowed:
  // it now needs the model to record a non-answer as the shape, rather than
  // merely to pick the wrong one of two true `knowledge` values. Code cannot
  // tell "every newly issued card, one track" from "nobody can say" without
  // reading the prose, and judging their words to RAISE a block is the one
  // thing `record.ts` forbids. So this is caught on the design instead:
  // `mustLearnAudience` holds, and a journey that learns nothing about who
  // converts is reported as a limitation on the campaign.
  //
  // So two things are required instead, both checkable:
  //  - at least TWO candidate segments, each with the agent's reasoning. One
  //    is a guess; two or more is a set of options the manager can react to,
  //    push back on, or rule out.
  //
  // THERE IS NO LONGER A SECOND REQUIREMENT, and the one that was here is
  // worth recording because it sounded right. It demanded a reply from the
  // manager AFTER the candidates were raised, to stop the agent treating its
  // own suggestion as agreed.
  //
  // Measured on the PIN-activation run, 2026-10-21. The manager had said
  // plainly they have no visibility on who already activates. The agent put
  // up two guess-groups resting on different things — welcome-offer sign-ups,
  // and customers who already hold another product. That is this question
  // answered: nobody knows, and here are the two candidates worth telling
  // apart. The gate held anyway, and the turn it produced said "I have put up
  // two possible groups to go after and I am waiting to hear which one you
  // would back", then re-asked "who tends to do this already today".
  //
  // Two things were wrong with it. It asked the manager to pick a targeting
  // group from the agent's own guesses, which is a decision neither of them
  // can make yet and the campaign exists to settle. And it made a rejection
  // unrepresentable: a manager saying "don't target off those guesses" is
  // agreement about the state of knowledge, not a refusal to answer, and the
  // old rule read it as the question still being open.
  //
  // The protection it was reaching for is real and lives where it belongs —
  // on the DESIGN, not the record. `mustLearnAudience` stays true whenever
  // nobody knows, and `checkAudienceLearning` refuses a flat single-audience
  // journey, so the candidates still have to be told apart by what gets
  // built. What is dropped is only the demand for another round of chat.
  //
  // The agent does the validating. The application only checks that what it
  // DECLARED holds together.
  //
  // It is not the user's job to notice that "high spenders" and "big
  // spenders" are the same group. The agent should have caught that before
  // putting them up. But the application cannot judge whether two segments
  // are meaningfully different either, because that is a question about
  // customer behaviour and no amount of code reaches it. So the agent
  // declares what each group RESTS ON, and the application checks those are
  // different. That is a structural check on its own claim, not a semantic
  // one on its meaning.
  const candidates = c.candidates ?? [];
  const complete = candidates.every((s) => s.segment.trim() && s.restsOn.trim() && s.why.trim());
  const bases = new Set(candidates.map((s) => s.restsOn.trim().toLowerCase()));
  const distinct = bases.size === candidates.length;
  return candidates.length >= 2 && complete && distinct;
};

/**
 * Must this campaign find out who converts, rather than target a known profile?
 *
 * True whenever nobody could say. The consequence is a requirement on the
 * DESIGN, not just on the record: a flat single-audience journey learns
 * nothing about who converts, so it is the wrong campaign for this situation
 * however well written its messages are. See `checkAudienceLearning`.
 */
export const mustLearnAudience = (c: Converters | null | undefined): boolean =>
  !!c && c.knowledge !== 'known';
