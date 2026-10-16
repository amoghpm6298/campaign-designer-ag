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
import type { WorkingBrief, OpenQuestion, DiscoveryDimension } from './discovery';

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
export function recordAsked(
  brief: WorkingBrief,
  questions: { text: string; impact?: OpenQuestion['impact']; contingency?: OpenQuestion['contingency'] }[],
  author: AskAuthor,
): WorkingBrief {
  const existing = qs(brief);
  const fresh: RecordedQuestion[] = questions
    .filter((q) => q.text.trim().length > 0)
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
  return { ...brief, questions: [...existing, ...fresh] };
}

/**
 * The user replied. Attribute it to everything outstanding, and advance the
 * round.
 *
 * This single function replaces `recordAnswer` + `recordAddressedQuestions` +
 * `recordUncoveredQuestions`. There is no longer a difference between "a reply
 * arrived" and "the reply covered this question", because the distinction was
 * only ever decidable by the model, and making the model's silence mean
 * "unanswered" is what told a manager their answer did not count.
 *
 * Forks are NOT excepted here, which reverses the rule written earlier the
 * same day. The exception existed because a wrongly-discharged fork builds the
 * wrong campaign silently — a real risk, and the reason `reopen` below exists.
 * But it was buying that safety with the one failure mode we know costs the
 * user's trust, and it bought it from the wrong budget: the protection belongs
 * in a bounded re-ask, not in a default that treats every reply as suspect.
 */
export function recordReply(brief: WorkingBrief, text: string): WorkingBrief {
  const round = brief.rounds + 1;
  const outstanding = qs(brief).filter((q) => q.answeredInRound === undefined);
  return {
    ...brief,
    rounds: round,
    answers: [...brief.answers, { round, text }],
    facts: [
      ...brief.facts,
      { statement: text, source: 'user-answer', round, confidence: 'confirmed', answers: outstanding.map((q) => q.id) },
    ],
    // Keyed on `addressedInRound`, NOT on `answeredInRound`. A question that
    // `reopen` put back needs re-addressing even though a reply had already
    // arrived once — testing the wrong field left a re-opened question
    // outstanding for ever, which is the loop this module exists to end.
    questions: qs(brief).map((q) =>
      q.addressedInRound === undefined
        ? { ...q, answeredInRound: q.answeredInRound ?? round, addressedInRound: round }
        : q,
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
];

/** Did the user say, in this reply, that they do not have the answer? */
export const saysUnknown = (text: string): boolean => {
  const t = text.toLowerCase();
  return DONT_KNOW.some((p) => t.includes(p));
};

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
