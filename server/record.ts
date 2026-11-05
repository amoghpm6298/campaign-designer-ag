// The application owns the conversation record.
//
// THE PREMISE THIS REPLACES, and it is the cause of every deadlock measured on
// 2026-10-16 rather than one of them. The application policed the agent
// through a gate, but it could not see the conversation — it only saw what the
// model chose to volunteer in optional fields. So it refused proposals based
// on an incomplete record it had not authored.
//
// Concretely: the manager named the barrier in turn 3 of a live session
// ("not realising they need to do bcs we are not nudging then"). The model
// understood it — the final strategy states that exact barrier. But it never
// emitted a `barriers` entry, so `brief.barriers` stayed empty, so the gate
// refused with "I do not yet know what is stopping them" and asked again. For
// five turns. The information was in the transcript the whole time.
//
// The fix is not a better prompt or a stricter schema. It is that the
// application asked the question, so the application attributes the answer.
// Nothing here waits for the model to confess.
//
// ONE SAFETY RULE governs everything below: a judgement the application makes
// about the user's words may only ever RELEASE a block, never create one. A
// false positive therefore costs a stated assumption the user can correct,
// not a campaign built on a guess and not a loop. Every heuristic in this file
// is one-directional for that reason.
import { readsAsDecline, recordAnswer, type WorkingBrief, type OpenQuestion, type DiscoveryDimension } from './discovery';

/**
 * Who wrote the question.
 *
 * It matters for attribution. When the APPLICATION asked ("In your own words,
 * what do you think is stopping them?"), the next reply can be attributed to
 * it with no judgement about content at all — we know what was on screen. The
 * agent's own questions get the same treatment, but the distinction is kept
 * because an application-authored question is also one the application is
 * allowed to answer on the user's behalf when they say they do not know.
 */
export type AskAuthor = 'app' | 'agent';

/** A question, plus the two fields this module adds to the record. */
export interface RecordedQuestion extends OpenQuestion {
  author?: AskAuthor;
  /**
   * How many times this question has been re-opened after a reply was
   * attributed to it. Hard-capped at REOPEN_LIMIT.
   *
   * This is the entire bound on re-asking, and it replaces `blockedCount`,
   * MAX_FORK_REFUSALS and the fork-escalation ladder. Those counted refusals,
   * which is a count of how often the APPLICATION gave up; this counts how
   * often the user has been asked the same thing twice, which is the thing
   * that actually annoyed them.
   */
  reopened?: number;
}

/**
 * A question may be re-opened once, and once only.
 *
 * One, not two. The old limit was two fork refusals plus a fallback, which in
 * practice meant a manager answering the same question three times. If a
 * reply plus one clarification has not settled something, asking a third time
 * does not settle it either — it is time to assume and say so.
 */
export const REOPEN_LIMIT = 1;

const qs = (brief: WorkingBrief): RecordedQuestion[] => (brief.questions ?? []) as RecordedQuestion[];

/**
 * Record questions as asked, attributing authorship.
 *
 * Does NOT bump `brief.rounds`. Rounds count exchanges with the user, and the
 * old code incremented them inside `recordQuestions`, which meant a turn where
 * the application supplied a fallback question consumed budget identically to
 * a turn where the agent genuinely asked something. Budget is spent by the
 * user replying, so `recordReply` owns the counter.
 */
/**
 * Has the user already closed the question of performance history?
 *
 * Read off the record — the limitation `noteOpeningFacts` writes, the facts it
 * records, or the objective itself — never guessed from the current reply.
 */
const historyIsClosed = (brief: WorkingBrief): boolean => {
  const said = [brief.objective, ...brief.limitations, ...brief.facts.map((f) => f.statement)].join(' ');
  return readsAsDecline(said) && /\b(history|historical|benchmarks?|baselines?|data|figures|records|rates?)\b/i.test(said);
};

/**
 * A question that asks for the thing they have already said does not exist.
 *
 * MEASURED, three live runs: the manager opened with "We have no campaign
 * history", and turn one asked "is there a target or benchmark you already
 * have in mind (a conversion rate, an EMI book amount) or is this genuinely
 * the first run?" — the closed question, reprinted, spending the one round
 * that should have gone on customers. SYSTEM has forbidden it in words for
 * weeks.
 *
 * NARROW ON PURPOSE. It matches the SCOREBOARD nouns only, so a question
 * about customers can never be silenced by it — and it fires only when the
 * record says the history is closed, so a manager who never mentioned it is
 * still asked.
 */
const asksForClosedHistory = (text: string): boolean =>
  /\b(benchmark|baseline|target|conversion rate|historical|history|past campaigns?|previous campaigns?|first run|book amount|industry average)\b/i.test(text);

// `alreadyAsksCustomerGap` LIVED HERE AND IS GONE WITH THE INJECT.
//
// It answered "has this turn already asked the customer question the gate
// would inject", which only had a caller while something was being injected.
//
// NO GAP MATCHER AND NO INJECT SURVIVES ANYWHERE. Measured: zero matches for
// either in `orchestrator.ts`. Job 2 deleted the `evaluateDiscovery` call that
// was the JSON path's version, and this deleted the tool path's.
//
// Said plainly because this comment got it wrong twice. The first version
// claimed the orchestrator still READ this function; the correction then
// claimed it kept its OWN matcher "for its own inject suppression". Both were
// invented, one sentence apart, and neither was measured before being written.
//
// THE ONLY FILL LEFT is the model asking nothing while the record is still
// open, and it writes `decide().blocks` reasons — each already naming what
// would clear it, in the manager's own terms. Four writers, all of them either
// the model's own texts or those reasons: `orchestrator.ts` 2349 and 2489
// (block reasons), 2848 (`askedByModel`), 2944 (`briefQuestionsForHold`, which
// is one or the other), and this function (what it was given).

export function recordAsked(
  brief: WorkingBrief,
  questions: { text: string; impact?: OpenQuestion['impact']; contingency?: OpenQuestion['contingency'] }[],
  author: AskAuthor,
): WorkingBrief {
  const existing = qs(brief);
  const closed = historyIsClosed(brief);
  let fresh: RecordedQuestion[] = questions
    .filter((q) => q.text.trim().length > 0)
    // A QUESTION THAT ONLY RESTATES A CLOSED FACT DOES NOT GO OUT. The same
    // family as the de-duplication below — the application declining to print
    // its own redundant question — and not a judgement that could refuse the
    // USER anything: the worst a false positive costs is one unasked
    // scoreboard question, and the substitution below guarantees the turn
    // still carries something to answer.
    .filter((q) => !(closed && asksForClosedHistory(q.text)))
    // Never ask the same thing twice in one breath. Matched on the exact text
    // because this is the application's own de-duplication, not a judgement
    // about whether two differently-worded questions mean the same thing.
    .filter((q) => !existing.some((e) => e.text.trim() === q.text.trim() && e.answeredInRound === undefined))
    .map((q, i) => ({
      id: `q${brief.rounds}-${existing.length + i}`,
      text: q.text.trim(),
      askedInRound: brief.rounds,
      author,
      ...(q.impact ? { impact: q.impact } : {}),
      ...(q.contingency ? { contingency: q.contingency } : {}),
    }));
  // THE RECORD GETS WHAT IT WAS GIVEN. NOTHING IS INJECTED.
  //
  // This used to append a canonical finding question — "Who tends to do this
  // already today…", "In your own words, what do you think is stopping the
  // rest?" — whenever `converters` or `barriers` were still missing, with
  // `author: 'app'`.
  //
  // MEASURED, `eval/runs/ui-s-1793168820316`. Turn 1: the model asked TWO
  // (how success is counted; the business reason for pushing EMI) and the
  // manager read THREE, the third being "Who tends to do this already today".
  // Turn 2: the model asked two more and the third was "In your own words,
  // what do you think is stopping the rest?". Both app rows, neither asked for.
  //
  // IT IS THE SAME DUAL WRITER AS `evaluateDiscovery`, THROUGH THE OTHER
  // DOOR. That one was deleted from `orchestrateStream` and the JSON `ask`
  // path went quiet, so the pin for it stayed green — while live Discovery
  // goes through the `ask_questions` TOOL, which lands here. One writer means
  // this one too: `decide` / `turnPhase` answers "are we done asking", and if
  // the model asked, the screen and the brief are exactly those texts.
  //
  // Completeness is not lost. `converters` still unset means `decide` still
  // holds the next turn — with the questions the model asks, or with the
  // blocks' own reasons if it asks none. Not with a row nobody emitted.
  //

  // AT MOST THREE ON THE RECORD, NOT ONLY ON THE SCREEN.
  //
  // MEASURED, turn 1 of `eval/runs/ui-s-1792984906680`. The model asked three,
  // the application injected a fourth, the response sliced to three — and the
  // FOURTH stayed outstanding on the brief, so the next turn was still waiting
  // for an answer nobody had been shown. Capping the list without capping the
  // record is how a question becomes unanswerable.
  //
  // The cap stays, and it is now a plain slice. The "which one gives way"
  // re-ordering that used to sit here existed ONLY to protect the injected
  // row from its own overflow — with nothing injected, `fresh` can exceed
  // three only when the MODEL asks more than three, and then the first three
  // it asked are the three that go out. Nothing is dropped from `existing`:
  // the cap applies to what this turn adds.
  const CAP = 3;
  fresh = fresh.slice(0, CAP);
  return { ...brief, questions: [...existing, ...fresh] };
}

/**
 * The user replied. It addresses everything that was on screen.
 *
 * ONE DEFINITION OF DONE, and this is the function that owns it. There is no
 * difference between "a reply arrived" and "the reply covered this question",
 * because the distinction was only ever decidable by the model, and making the
 * model's silence mean "unanswered" is what told a manager their answer did
 * not count.
 *
 * IT WAS WRITTEN AND NEVER WIRED, which cost a whole live conversation.
 * `eval/runs/ui-s-1792839251135`: three turns, the manager settled success,
 * who converts, the barrier and the extra-axis probe, and all four questions
 * ended with `answeredInRound: 0` and `addressedInRound: undefined`. Live
 * ingest called `recordAnswer` — which sets only the first field — while
 * `outstanding` and `decide` read the second. Two fields, two write-paths, and
 * the gate held `awaiting-reply` on four answered questions for three turns.
 * The orchestrator now goes through `receive` below, so attribution happens in
 * the same write as the answer text.
 *
 * IT DOES NOT ADVANCE THE ROUND, since 2026-10-24. It used to, while
 * `recordAnswer` did not — so wiring it into ingest would have counted a round
 * for the reply AND a round for the questions that went out with it.
 * `MAX_ROUNDS` is "rounds of questions before the agent must work with what it
 * has", so the counter belongs to `recordQuestions` and
 * `recordEvidenceRequests`, which is where it already lived. One meaning, one
 * writer.
 *
 * Forks are NOT excepted here, which reverses the rule written earlier the
 * same day. The exception existed because a wrongly-discharged fork builds the
 * wrong campaign silently — a real risk, and the reason `reopen` below exists.
 * But it was buying that safety with the one failure mode we know costs the
 * user's trust, and it bought it from the wrong budget: the protection belongs
 * in a bounded re-ask, not in a default that treats every reply as suspect.
 */
export function recordReply(brief: WorkingBrief, text: string): WorkingBrief {
  // ONE ANSWER-WRITER. `recordAnswer` appends the reply, writes it as a
  // confirmed fact carrying the ids it settles, and sets `answeredInRound`.
  // This used to restate all of that inline, which is how the two write-paths
  // came to disagree about which field means done. Here it is composed:
  // recording the answer, then closing what was on screen.
  const answered = recordAnswer(brief, text);
  const round = answered.rounds;
  return {
    ...answered,
    // Keyed on `addressedInRound`, NOT on `answeredInRound`. A question that
    // `reopen` put back needs re-addressing even though a reply had already
    // arrived once — testing the wrong field left a re-opened question
    // outstanding for ever, which is the loop this module exists to end.
    questions: qs(answered).map((q) =>
      q.addressedInRound === undefined ? { ...q, addressedInRound: round } : q,
    ),
  };
}

/**
 * Re-open specific questions the model reports a reply did not cover.
 *
 * The model is the only thing that can read a reply and notice a question went
 * untouched, so it keeps that job. What it no longer has is the power to do it
 * indefinitely: past REOPEN_LIMIT the question stays closed and the agent must
 * proceed on a stated assumption.
 *
 * Ignores ids that were never asked, and ids with no reply yet — a question
 * asked this turn cannot have been missed by a reply that predates it.
 */
export function reopen(brief: WorkingBrief, ids: string[] | undefined): WorkingBrief {
  const want = new Set((ids ?? []).map((i) => i.trim()).filter(Boolean));
  if (want.size === 0) return brief;
  return {
    ...brief,
    questions: qs(brief).map((q) => {
      if (!want.has(q.id)) return q;
      if (q.answeredInRound === undefined) return q;
      if ((q.reopened ?? 0) >= REOPEN_LIMIT) return q;
      return { ...q, addressedInRound: undefined, reopened: (q.reopened ?? 0) + 1 };
    }),
  };
}

/** Questions genuinely awaiting a reply. */
export const outstanding = (brief: WorkingBrief): RecordedQuestion[] =>
  qs(brief).filter((q) => q.addressedInRound === undefined);

/** A question that has used up its one re-ask and must now be assumed past. */
export const exhausted = (brief: WorkingBrief): RecordedQuestion[] =>
  qs(brief).filter((q) => (q.reopened ?? 0) >= REOPEN_LIMIT && q.addressedInRound !== undefined);

/**
 * Phrases in which a person says they do not have the answer.
 *
 * Deliberately short, literal and lower-cased. It is not trying to understand
 * the reply — a longer list would start guessing at meaning, and the point of
 * keeping it crude is that it stays auditable.
 *
 * SAFETY: a match here can only ever convert a blocking dimension into a
 * stated assumption. It cannot close a question, cannot set a finding, and
 * cannot cause a refusal. So the cost of a false positive is an assumption
 * printed to the user with its reason, which they can correct in one line.
 */
export const DONT_KNOW = [
  'not sure',
  "don't know",
  'dont know',
  'do not know',
  'no idea',
  'no data',
  "haven't tested",
  'havent tested',
  'have not tested',
  "don't have data",
  'dont have data',
  'do not have data',
  'cannot say',
  "can't say",
  'unsure',
  'no visibility',
  // "We don't track that" is the same answer as "I don't know", and it was the
  // one the live run actually got. MEASURED, `eval/runs/ui-s-1793611326664`.
  "don't track",
  'dont track',
];

/** Did the user say, in this reply, that they do not have the answer? */
export const saysUnknown = (text: string): boolean => {
  const t = text.toLowerCase();
  return DONT_KNOW.some((p) => t.includes(p));
};

/**
 * "We do not know why" IS an answer about why, and it is theirs.
 *
 * MEASURED, `eval/runs/ui-s-1793611326664`. The manager said they do not track
 * why dormant cardholders stay inactive. The model filed it honestly enough as
 * a barrier called `reason-unknown` — and gave it `basis: 'none'` with
 * `lever: 'not-addressable'`. Both are wrong in a way that stalls the
 * conversation:
 *
 *  - `basis: 'none'` means nobody said it, so `designableBarriers` drops the
 *    row and `no-barrier` holds. The manager answered and the gate did not
 *    hear it.
 *  - `not-addressable` means "this reason is real and a drip cannot fix it".
 *    Not knowing the reason is not that. It is the thing the first run exists
 *    to find out.
 *
 * So the row becomes theirs: `basis: 'user'`, their words as the quote, and a
 * lever that leaves Plan free to test. `no-barrier` then clears on its own,
 * because `designableBarriers` already accepts `basis: 'user'` — the block is
 * not demoted and nothing else about it changes.
 *
 * WHY IT RUNS AFTER `record_findings` AND NOT BESIDE `settleUnknowns`. The
 * inbound reply is settled first, then the model's own tool call writes the
 * barriers — so a rewrite that only ran on the way in would be overwritten by
 * the very filing it exists to correct. The last write has to be this one.
 *
 * WHAT IT WILL NOT DO. It fires only while there is NO designable barrier on
 * the record, so a reason the manager really did state can never be rewritten,
 * and a stated reason they say a drip cannot fix stays exactly as filed. It
 * invents no second cause. It reads only `DONT_KNOW`, which may convert a row
 * and may never create a refusal.
 */
export function fileUnknownWhy(brief: WorkingBrief): WorkingBrief {
  const reply = brief.answers?.[brief.answers.length - 1]?.text ?? '';
  if (!reply.trim() || !saysUnknown(reply)) return brief;
  const rows = brief.barriers ?? [];
  // A barrier THEY stated means the why question is answered. Nothing here
  // touches it.
  //
  // `assumption` IS NOT IN THAT LIST, and that was the whole defect.
  // MEASURED, `eval/runs/ui-s-1793616608652` turn 3: they answered "1. not
  // sure / 2. not sure / 3. not really", the model filed `why-dormant-unknown`
  // as `user` quoting "not sure", and `quoteIsTheirs` wants three content
  // words — so attribution stored it as `assumption`. This function then bailed
  // on any assumption, `mustTestBarriers` stayed true, and Plan shipped a
  // two-arm "forgot the card" against "switched to UPI" experiment over a
  // reason nobody had given. Confirm built it.
  //
  // An unknown filed under a weaker basis is still the manager saying they do
  // not know. A cause the agent GUESSED is not, and the quote is what tells
  // the two apart.
  if (rows.some((b) => b.basis === 'user' || b.basis === 'user-belief')) return brief;

  const theirs = {
    basis: 'user' as const,
    // THE LEVER IS NOT A CLAIM ABOUT THE CAUSE. There is no "unknown" lever,
    // and `not-addressable` is the one thing this must not be. `message` is
    // the instrument a first run uses to find out, and the statement says
    // plainly that the reason is unknown so nothing downstream reads a cause
    // into it.
    lever: 'message' as const,
    quote: reply.trim().slice(0, 300),
  };
  const statement = 'They do not know why the rest do not convert, and said so. This run has to find out.';

  // Rewrite the row the model filed for this reply, if it filed one.
  //
  // THE ASSUMPTION ROW HAS TO BE IN THIS SEARCH, not only `none` and
  // `not-addressable`. Dropping the bail above without widening it appends
  // `reason-unknown` BESIDE the bad row: `mustTestBarriers` goes false, the
  // quasi-cause stays on the record, and the brief then carries two barriers
  // where the manager gave none. One row after this reply, never two.
  //
  // An assumption only qualifies when its own quote is itself an unknown —
  // "not sure" is enough. A guessed cause carries a CAUSE in the quote, and
  // that row is left exactly as the model filed it.
  const wrong = rows.findIndex(
    (b) => b.basis === 'none' || b.lever === 'not-addressable' || (b.basis === 'assumption' && saysUnknown(b.quote ?? '')),
  );
  if (wrong >= 0) {
    const next = [...rows];
    // THE STATEMENT IS REPLACED, not kept. The model's wording for an unknown
    // reads as a quasi-cause often enough to matter, and every reader
    // downstream takes the statement as what the campaign is attacking.
    next[wrong] = { ...next[wrong], ...theirs, statement };
    return { ...brief, barriers: next };
  }
  return {
    ...brief,
    barriers: [...rows, { id: 'reason-unknown', statement, ...theirs }],
  };
}

/**
 * Convert dimensions the user has just said they cannot settle into stated
 * assumptions.
 *
 * THE DEADLOCK THIS ENDS, measured: "Point in the two-week window where
 * engagement drops" was raised by the agent, the manager answered "not sure",
 * and it then blocked a proposal for five consecutive turns. There was no
 * answer the manager could give — it needed data the bank does not have — and
 * the gate held out for a `note` that nobody had told the model to write.
 *
 * The earlier fix told the model, in the brief, that a note was what released
 * it. That was the wrong layer: the application already knew the user had said
 * "not sure", and sat there waiting to be informed of it. Now it acts.
 *
 * Only ever touches a dimension with no note, and only ever gives it one. It
 * never changes a status the agent set, so "retained" stays retained and the
 * agent's own reasoning is not overwritten.
 */
export function settleUnknowns(brief: WorkingBrief, reply: string): WorkingBrief {
  if (!saysUnknown(reply)) return brief;
  const dims = brief.dimensions ?? [];
  if (dims.length === 0) return brief;
  return {
    ...brief,
    dimensions: dims.map((d: DiscoveryDimension) =>
      (d.note ?? '').trim().length === 0
        ? {
            ...d,
            note: `The user was asked and said they do not know, so this is carried as an assumption rather than a finding. Their words: "${reply.trim().slice(0, 160)}"`,
          }
        : d,
    ),
  };
}

/**
 * Did the user tell us to get on with it?
 *
 * Same crude-and-auditable approach as DONT_KNOW, and the same one-way safety:
 * this can only ever release the agent to propose. It cannot block.
 *
 * MEASURED: a manager typed "ok go ahead", received a refusal, typed "ok go
 * ahead" again, and only then got a strategy — and the second one did not work
 * either, the round budget expiring did. `forceProposal` was set in exactly one
 * place in the whole app, a button click in CampaignDesigner.tsx. An explicit
 * instruction to proceed has to take effect on the turn it is given.
 */
export const PROCEED = [
  'go ahead',
  'proceed',
  'just build',
  'build it',
  'get on with it',
  'stop asking',
  'enough questions',
  'no more questions',
  "that's everything",
  'thats everything',
  'that is everything',
];

export const saysProceed = (text: string): boolean => {
  const t = text.toLowerCase();
  return PROCEED.some((p) => t.includes(p));
};

/**
 * The words the Confirm button sends, typed by hand.
 *
 * The button posts `intent: 'confirm'` AND the sentence "Confirmed. Build
 * this campaign." Someone who types that sentence instead — reasonably,
 * since it is on screen in their own transcript — sends no intent, so the
 * turn was not a build turn and the plan was discussed again.
 *
 * `saysProceed` is NOT the same thing and must not be reused here: it
 * releases the discovery gate ("go ahead", "stop asking") and is deliberately
 * loose, because a false positive there costs a stated assumption. Starting a
 * BUILD on a loose match is a different risk — "do not build it yet" contains
 * "build it". So this is an exact match on the one phrase the product itself
 * puts in front of them.
 */
const CONFIRM_PHRASE = 'confirmed. build this campaign.';
export const saysBuildNow = (text: string): boolean =>
  text.trim().toLowerCase().replace(/\s+/g, ' ') === CONFIRM_PHRASE;

/**
 * One pass over a new user message: attribute it, settle what they said they
 * cannot answer, and report whether they asked us to move on.
 *
 * Kept as one entry point so a caller cannot apply half of it. The old code
 * had the answer recorded in one place, attribution in another and the
 * dimension record in a third, and the three disagreed.
 */
export function receive(brief: WorkingBrief, text: string): { brief: WorkingBrief; proceed: boolean } {
  const replied = recordReply(brief, text);
  return { brief: settleUnknowns(replied, text), proceed: saysProceed(text) };
}
