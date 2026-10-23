// The discovery gate.
//
// ROOT CAUSE this exists to fix: the only thing deciding "ask more" vs
// "propose a strategy" was the model's own `action` field. A model that
// opened with action:"propose" skipped discovery entirely, and the prompt was
// the sole constraint. The application never formed its own view of whether
// material information was missing.
//
// So discovery is now evaluated HERE, deterministically, from the accumulated
// brief. The model proposes; the application decides. A proposal is rejected
// and converted back into questions when uncertainties the model itself
// raised remain unresolved.
//
// The rules below are deliberately generic: nothing names EMI, activation or
// any other campaign. What they test is whether the AGENT's own stated
// uncertainties have been addressed by the user, not whether some fixed
// checklist of fields is filled in.

/**
 * What discovery decided this round.
 *
 * `request_evidence` is distinct from `ask_questions` on purpose: a question
 * resolves a BUSINESS DEFINITION the user knows, whereas an evidence request
 * asks for aggregated data they may simply not have. The difference matters
 * because an unanswered question can block a strategy, and missing evidence
 * must not — it becomes a stated limitation instead.
 */
import type { StatedValue } from './conflicts';
import { convertersSettled, designableBarriers, type Barrier, type BarrierLever, type ConverterKnowledge, type Converters, type FindingBasis } from './findings';

export type DiscoveryOutcome =
  | 'ask_questions'
  | 'request_evidence'
  | 'ready_for_strategy'
  /**
   * The model proposed a strategy AND something material is still open.
   *
   * This outcome exists because the previous two were not enough to express
   * the situation that actually matters: a recommendation worth reading that
   * still has a question attached. Discovery used to collapse that case into
   * 'ask_questions', and the orchestrator then returned questions with the
   * strategy fields left null — so a complete, useful strategy was destroyed
   * for having an honest open item, while the prompt was simultaneously
   * instructing the model to declare its open items.
   */
  | 'strategy_with_questions'
  /**
   * Discovery is not finished, so there is no strategy to show yet.
   *
   * This is the LOWER bound the gate never had. Every other outcome assumed
   * the model had already done enough thinking; `forced || rounds >= maxRounds`
   * was the only limit, and it only ever pushed TOWARDS a proposal. A model
   * that opened with action:"propose" was taken at its word, which is why two
   * measured conversations produced one question each — both about trigger
   * configuration, neither about who the customers were.
   *
   * Unlike 'strategy_with_questions', nothing is proposed here: an incomplete
   * investigation has no recommendation worth attaching a question to.
   */
  | 'continue_discovery';

/**
 * What kind of thing is still open. The MODEL classifies these, because only
 * it knows whether "which status means expired" is a definition it needs or a
 * detail it can assume.
 *
 * This replaces two regex classifiers. `isEvidenceGap` decided blocking-ness
 * from phrasing, and got it backwards in both directions on real strings:
 * "the exact message copy and CTA wording" was treated as material and
 * blocked a campaign, while "the optimal number of reminders" was treated as
 * mere evidence. A model that already knows what it is unsure about does not
 * need its own words re-interpreted by a pattern list.
 */
export type OpenItemKind =
  /** A business definition only the user can settle, which would change the design. */
  | 'strategic-ambiguity'
  /** Aggregated data that would improve a decision. Never a prerequisite. */
  | 'evidence-gap'
  /** A detail with a sensible default, stated rather than asked. */
  | 'optional-preference'
  /** Something the platform cannot confirm either way. */
  | 'operational-limitation';

export interface OpenItem {
  kind: OpenItemKind;
  /** The question, or for a limitation, the statement. */
  question: string;
  /** Why it matters to this design. */
  whyItMatters?: string;
  /** What the agent proceeds with if nobody answers. */
  ifUnanswered?: string;
}

/** Only a strategic ambiguity is put to the user as a question that matters. */
const isBlockingItem = (i: OpenItem) => i.kind === 'strategic-ambiguity';

export interface OpenQuestion {
  /** Stable id so an answer can be attributed to the question it answers. */
  id: string;
  text: string;
  askedInRound: number;
  /**
   * A reply ARRIVED in this round. It does not mean this particular question
   * was answered: the user writes one free-text message and may address two of
   * three questions, or none of them.
   */
  answeredInRound?: number;
  /**
   * The agent confirmed the reply actually addressed THIS question, naming its
   * id. Absent means the question was asked, a reply came, and nothing has
   * claimed it covered this one.
   *
   * WHY THIS EXISTS, measured on the OS-to-EMI run: the user was asked whether
   * the gap was customers who had never started a request or ones already
   * sitting Pending — a question they could answer in three words, and one
   * that decides the entry event. Their reply talked about targets, balance
   * size and cost hesitation, and never mentioned it. `recordAnswer` marked it
   * answered anyway, the brief reported it as answered, and the agent — which
   * could see the reply did not cover it — reconciled the contradiction by
   * inventing a history ("Asked twice... user repeated the general hunch both
   * times") and filing the dimension as a deferred ASSUMPTION.
   *
   * The id was always here for this. Nothing used it.
   */
  addressedInRound?: number;
  /**
   * How much the ANSWER could change, declared when the question is asked.
   *
   *  fork     — it changes the goal, the intended audience, the entry event or
   *             the core intervention. Two different answers mean two
   *             different campaigns, not two versions of one.
   *  shaping  — it changes how the campaign is built, not what it is.
   *  detail   — a sensible default exists and stating it costs nothing.
   *
   * WHY IT IS DECLARED WHEN ASKING, not when proposing: by proposal time the
   * agent has an incentive to call an awkward question a detail so it can get
   * on with the design. Asked first, before it knows it will want to skip the
   * answer, the claim costs it nothing to make honestly. The separation is the
   * point — this is still the model's own judgement and it can be wrong, but
   * it is committed to in advance.
   */
  impact?: QuestionImpact;
  /**
   * What the answer would actually change. Required on a `fork`.
   *
   * THE DEFECT THIS ADDRESSES: `impact` is a claim about how much rides on a
   * question, and nothing could check it. The agent marked questions `fork`
   * and the application had to take its word. A contingency is the same claim
   * made checkable — if two answers lead to the same decision, then whatever
   * it was labelled, the question changes nothing and asking it spends the
   * user's attention for no return.
   *
   * The check is deliberately narrow and is the same one used for candidate
   * architectures: compare the declared CONSEQUENCES, never the prose about
   * them. `thenA` and `thenB` being the same means the question is idle. It
   * cannot tell whether either consequence is a good idea.
   */
  contingency?: QuestionContingency;
  /**
   * How many times a proposal has been refused because this fork was still
   * unanswered.
   *
   * MEASURED: the fork guard refused on turn 3 and refused again on turn 4
   * with WORD-FOR-WORD identical text. The user had replied in between; their
   * reply simply did not cover this question. With nothing to do about that,
   * regenerating the same sentence was the only move the application had — so
   * the application was doing precisely what this codebase forbids the agent
   * from doing, which is to treat repetition as a fallback.
   */
  blockedCount?: number;
}

/**
 * If they say A we do one thing, if they say B we do another, and if they
 * cannot answer we fall back to something stated.
 *
 * `ifUnknown` is not padding. A fork with no fallback is how a question ends
 * up asked three times in a row: with nothing to do when the answer does not
 * come, repeating it is the only move left. Measured on the first
 * counterfactual run, where the same goal question was put three times.
 */
export interface QuestionContingency {
  /** One plausible answer. */
  ifA: string;
  /** What would be done given that answer. */
  thenA: string;
  /** A materially different plausible answer. */
  ifB: string;
  /** What would be done instead. Must differ from thenA. */
  thenB: string;
  /** The stated default if the user cannot answer at all. */
  ifUnknown: string;
}

export type QuestionImpact = 'fork' | 'shaping' | 'detail';

export const QUESTION_IMPACTS: readonly QuestionImpact[] = ['fork', 'shaping', 'detail'] as const;

/**
 * Keeps only a value the application recognises.
 *
 * A missing or unrecognised impact is left UNDEFINED on purpose. Defaulting it
 * to 'detail' would take the one case this whole mechanism exists for — a
 * material question nobody classified — and mark it as the least important
 * kind there is. Unclassified is carried as unclassified: it cannot be
 * silently dropped (see `unresolvedQuestions`), and the brief asks for the
 * missing classification by name.
 */
export const asImpact = (v: unknown): QuestionImpact | undefined =>
  typeof v === 'string' && (QUESTION_IMPACTS as readonly string[]).includes(v.trim())
    ? (v.trim() as QuestionImpact)
    : undefined;

const RESOLUTION_KINDS = ['carried', 'deferred'] as const;

/**
 * How the agent decided to proceed WITHOUT an answer, tied to the question it
 * refers to. A reason attached to no question resolves no question — which is
 * exactly how a strategy with one unrelated assumption used to discharge every
 * outstanding question at once.
 */
export interface QuestionResolution {
  questionId: string;
  /** 'carried' — kept as live uncertainty. 'deferred' — a default applies. */
  kind: 'carried' | 'deferred';
  why: string;
}

/**
 * A request for aggregated data that would improve a specific decision.
 *
 * Deliberately NOT a prerequisite. Its whole purpose is to be answerable with
 * "we don't have that", after which the agent proceeds with a qualified
 * recommendation. `status` records which happened, so the same data is never
 * asked for twice.
 */
export interface EvidenceRequest {
  id: string;
  /** The decision this data would inform. */
  question: string;
  /** Fields/metrics needed, e.g. "amount bucket, authorised count, converted count". */
  fields: string[];
  /** How it should be grouped or bucketed. */
  grouping?: string;
  /** Period that would be useful. */
  period?: string;
  /** What the agent would do differently depending on the answer. */
  wouldInform: string;
  askedInRound: number;
  status: 'pending' | 'supplied' | 'unavailable';
  /** What the user actually gave, when they did. */
  suppliedSummary?: string;
}

/**
 * A fact the agent is treating as true, where it came from, and how sure we
 * are of it.
 *
 * `confidence` is the distinction the gate turns on: only a CONFIRMED fact —
 * something the user actually told us — may retire an open question. An
 * assumption or a proposed value never can, which is what stops the system
 * mistaking "we decided to guess this" for "we know this".
 */
export interface BriefFact {
  statement: string;
  source: 'user-answer' | 'retrieved-context' | 'platform-capability' | 'assumption';
  round: number;
  /** Defaults to 'confirmed' for a user answer, 'assumed' for anything else. */
  confidence?: 'confirmed' | 'assumed' | 'proposed';
  /** Ids of the open questions this answer settled, when known. */
  answers?: string[];
}

/**
 * What has happened to one line of enquiry.
 *
 *  open        — still being investigated; the strategy is not settled on it.
 *  retained    — resolved and USED in the design.
 *  deferred    — could matter, deliberately not pursued now; the reason is
 *                recorded so it is a decision rather than an omission.
 *  unavailable — the platform cannot express it at all. This is the status
 *                that must become a disclosed limitation rather than a
 *                silently dropped idea, which is how OS amount bucketing
 *                vanished from a real OS-to-EMI conversation.
 */
export type DimensionStatus = 'open' | 'retained' | 'deferred' | 'unavailable';

/**
 * WHAT the status rests on. Kept separate from the status so "we checked and
 * it isn't there" can never read the same as "we assumed it isn't there".
 *
 *  tool        — a tool reported it.
 *  user        — the user stated it as fact. Something they OWN and are the
 *                authority on: their definition of "dormant", their success
 *                measure, their decision to treat everyone the same.
 *  user-belief — the user offered it as their explanation of why customers
 *                behave as they do. Their conjecture, not their knowledge.
 *  assumption  — nobody established it; the agent chose to proceed.
 *  none        — nothing yet.
 *
 * WHY 'user' AND 'user-belief' ARE SEPARATE, measured live: "dormant means no
 * transaction in 6 months" and "we think they've just forgotten about the
 * card" both recorded as basis 'user' and were indistinguishable afterwards.
 * The first is a definition the business owns; the second is a hypothesis
 * about causation that the business cannot actually know. Collapsing them is
 * how a stated belief became the established cause a whole campaign was built
 * on, with nothing anywhere recording that it had never been tested.
 *
 * DERIVED from `FindingBasis` rather than restated, so the two cannot drift.
 * The only difference is 'tool': a dimension can rest on something a tool
 * reported, but a finding about why customers behave as they do cannot —
 * nothing here can report that. See server/findings.ts.
 */
export type DimensionBasis = FindingBasis | 'tool';

/**
 * One dimension of the campaign the agent considered. The point of recording
 * these is that a dimension NEVER examined and one examined and dismissed are
 * different things, and the application previously could not tell them apart:
 * the brief held flat lists of facts and questions with nothing saying which
 * aspects of the design had been looked at.
 */
export interface DiscoveryDimension {
  /** Identity. Matched case-insensitively, because a model supplies it. */
  name: string;
  /** Why it could matter to THIS objective. */
  rationale: string;
  status: DimensionStatus;
  basis: DimensionBasis;
  /** What was found, deferred or ruled out, in the agent's own words. */
  note?: string;
}

/**
 * An update to one dimension. Only `name` is required: a later round may
 * change a status without restating the rationale, and whatever it omits must
 * survive rather than be blanked. See `recordDimensions`.
 */
export type DimensionUpdate = { name: string } & Partial<Omit<DiscoveryDimension, 'name'>>;

/**
 * The brief as it accumulates. This is the application's own record — it is
 * what discovery is evaluated against, and it survives every model call.
 */
export interface WorkingBrief {
  /** The objective as first stated. */
  objective: string;
  /** Normalised, for detecting a material change after confirmation. */
  objectiveFingerprint: string;
  rounds: number;
  questions: OpenQuestion[];
  /** Per-question decisions to carry or defer, each naming its question. */
  questionResolutions?: QuestionResolution[];
  /** Free-text answers the user has given, in order. */
  answers: { round: number; text: string }[];
  /** Uncertainties the agent itself flagged and has not resolved. */
  openUncertainties: string[];
  /** Data the agent asked for, and what came back. */
  evidenceRequests: EvidenceRequest[];
  /**
   * Confirmed definitions, retrieved facts and working assumptions. Carried
   * forward so later rounds never contradict or re-ask what is settled.
   */
  facts: BriefFact[];
  /** Limitations to state in the strategy, e.g. evidence that was unavailable. */
  limitations: string[];
  /**
   * Values the user stated, checked against platform metadata. Kept verbatim
   * so a mismatch can be explained without rewriting what they asked for.
   */
  statedValues?: StatedValue[];
  /**
   * The lines of enquiry considered, and what became of each. Optional for
   * the same reason `statedValues` is: a brief persisted by an older client
   * round-trips without it, so every reader defaults it rather than assuming
   * it is present.
   */
  dimensions?: DiscoveryDimension[];
  /**
   * How success would be judged, in the user's terms. Recorded separately
   * from the goal EVENT: the event proves the behaviour happened, this says
   * what the business would count. Never a target value — no performance
   * history exists to set one against.
   */
  successCriteria?: string[];
  /** What the application concluded about each proposal, newest last. */
  verdicts?: ApplicationVerdict[];
  /**
   * Which sources were actually consulted, and whether anything was found.
   * Exists so the agent can report what it checked without implying it
   * searched places it has no access to.
   */
  contextChecked?: { source: string; found: boolean }[];
  /**
   * Who converts today, in the manager's own words. See server/findings.ts.
   *
   * Starts absent and must be filled from the conversation. There is no
   * performance data anywhere in this prototype, so the manager's anecdote is
   * the only evidence of what already works — and it is what decides whether
   * the campaign doubles down on that profile or goes after everyone else.
   */
  converters?: Converters;
  /**
   * Names `recordDimensions` refused to store because they describe the
   * platform rather than the customer.
   *
   * Kept so the model can be TOLD. Dropping them silently reproduced the
   * deadlock this project keeps hitting: the agent raised three dimensions,
   * none were stored, the gate said "raise at least 3", and the agent — with
   * no way to know what had happened — raised the same three again.
   */
  droppedDimensions?: string[];
  /**
   * Block codes reported to the user on the previous refusal.
   *
   * Exists so a refusal can report the DELTA. A live session refused five
   * turns running with an identical opening paragraph while the questions
   * underneath changed every turn, so visible progress read as a frozen loop.
   * Optional, because a brief saved before this field round-trips without it.
   */
  lastBlocks?: string[];
  /**
   * Why the rest do not convert. Starts empty, deliberately: a seeded list
   * would turn discovery into multiple choice. A barrier may only be designed
   * against once it traces to something the manager said.
   */
  barriers?: Barrier[];
}

export function newBrief(objective: string): WorkingBrief {
  return {
    objective,
    objectiveFingerprint: fingerprint(objective),
    rounds: 0,
    questions: [],
    answers: [],
    openUncertainties: [],
    evidenceRequests: [],
    facts: [],
    limitations: [],
    statedValues: [],
    dimensions: [],
    successCriteria: [],
    verdicts: [],
    contextChecked: [],
  };
}

/**
 * A coarse content fingerprint: the significant words in the objective.
 *
 * Used only to notice that the user has materially changed what they are
 * asking for, which must invalidate a confirmation given for the old brief.
 *
 * THE LENGTH FILTER WAS THE SUBJECT-REMOVING BUG. It used to require more
 * than three characters, which silently discarded every short term this
 * domain actually turns on — OS, EMI, SMS, DNC, NPA, KYC, MCC, RCS, Txn, APR.
 * "I want to increase OS-to-EMI conversions. Design a drip campaign for this."
 * fingerprinted to "campaign conversions design drip increase": five generic
 * words with the campaign's identity erased.
 *
 * Measured consequence: confirming a strategy the agent had just proposed was
 * REFUSED with "the objective changed after this strategy was proposed",
 * because the strategy summary says "OS-to-EMI" and the objective fingerprint
 * no longer contained it. Shared tokens: 0. Overlap: 0.000 against a 0.25
 * threshold. The threshold was never the problem.
 *
 * Two characters is the floor because the shortest real term here is "OS".
 * The stop list still removes the short function words that matter ("to",
 * "of", "in", "on", "is", "it", "we", "do", "be"), so lowering the floor
 * admits domain nouns rather than grammar.
 */
export function fingerprint(text: string): string {
  const stop = new Set([
    'the','a','an','and','or','to','of','for','with','our','we','i','is','are','that','this','it','in','on','be',
    'get','make','want','need','more','them','their','they','not','but','so','do','have','has','can','should',
  ]);
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 1 && !stop.has(w)),
    ),
  ]
    .sort()
    .join(' ');
}

/**
 * Has the objective changed materially? Compares significant-word overlap.
 * A reworded brief is the same brief; a different goal is not.
 */
export function objectiveChangedMaterially(before: string, after: string): boolean {
  const a = new Set(fingerprint(before).split(' ').filter(Boolean));
  const b = new Set(fingerprint(after).split(' ').filter(Boolean));
  if (!a.size || !b.size) return false;
  const shared = [...a].filter((w) => b.has(w)).length;
  const overlap = shared / Math.max(a.size, b.size);
  return overlap < 0.5;
}

export interface GateInput {
  brief: WorkingBrief;
  /** What the model asked for this turn. */
  modelAction: 'ask' | 'request_evidence' | 'propose';
  /** Questions the model wants to ask, if any. */
  modelQuestions: string[];
  /** Data the model wants, when modelAction is 'request_evidence'. */
  modelEvidence?: Omit<EvidenceRequest, 'id' | 'askedInRound' | 'status'>[];
  /**
   * What the model says is still open, classified by the model itself.
   * Preferred over `declaredUnknowns`.
   */
  openItems?: OpenItem[];
  /**
   * Legacy: bare uncertainty strings, with no kind attached. Read only when
   * `openItems` is absent, and treated as strategic ambiguity — the
   * conservative reading, since an unclassified uncertainty might be one.
   * They no longer suppress the strategy, so over-classifying is now cheap.
   */
  declaredUnknowns?: string[];
  /**
   * Open items the APPLICATION found, not the model: a value the user stated
   * that the platform cannot represent. These bypass the already-covered
   * filter on purpose — the words come from the user's own message, so
   * matching them against that message would suppress every one of them.
   */
  appOpenItems?: OpenItem[];
  /** The user forced a proposal, or the round limit was reached. */
  forced: boolean;
  maxRounds: number;
  /**
   * A campaign already exists and the user asked for a change. Discovery is
   * behind them, so the discovery-first rule must not re-gate a refinement.
   */
  isRefinement?: boolean;
}

export interface GateDecision {
  outcome: DiscoveryOutcome;
  /** Questions to put to the user. Empty when ready_for_strategy. */
  questions: string[];
  /** Data to request. Only populated for request_evidence. */
  evidence: Omit<EvidenceRequest, 'id' | 'askedInRound' | 'status'>[];
  /** Why the application decided this, for the run log and the UI. */
  reason: string;
  /** True when the application overrode a model proposal. */
  overrodeModel: boolean;
  /**
   * Everything still open, carried through so the reply can show it next to
   * the strategy instead of discarding it. Blocking items also appear in
   * `questions`; the rest are shown as context the user may act on or ignore.
   */
  openItems: OpenItem[];
}

/**
 * The gate. Called on every conversation turn, before anything is built.
 *
 * It can only ever be MORE conservative than the model: it never turns
 * "ask" into "ready", because the model asking is itself evidence that
 * something is unresolved.
 */
export function evaluateDiscovery(input: GateInput): GateDecision {
  const { brief, modelAction, modelQuestions, modelEvidence, forced, maxRounds, isRefinement } = input;
  const none: Omit<EvidenceRequest, 'id' | 'askedInRound' | 'status'>[] = [];

  // Everything the model says is open, in one classified list. Unclassified
  // legacy strings are read as strategic ambiguity.
  const declared: OpenItem[] = input.openItems?.length
    ? input.openItems
    : (input.declaredUnknowns ?? []).map((question) => ({ kind: 'strategic-ambiguity' as const, question }));

  // An item the user has already been asked, or has already answered, is not
  // open any more. This is the ONLY place lexical matching survives, and it
  // compares against what the USER said — never against the retrieved
  // context. A term appearing in the knowledge base or the vocabulary says
  // nothing about whether its value is known, which is precisely how the
  // question "is the entry a Transaction event or an EMI Request event?" used
  // to be suppressed: the vocabulary lists both, so every word matched.
  const stillOpen = [...(input.appOpenItems ?? []), ...declared.filter((i) => !alreadyCovered(i.question, brief))];

  // The user explicitly asked to proceed, or the budget is spent.
  if (forced || brief.rounds >= maxRounds) {
    return {
      outcome: 'ready_for_strategy',
      questions: [],
      evidence: none,
      reason: forced
        ? 'You asked to proceed, so the agent is working with what it has.'
        : `Discovery limit of ${maxRounds} rounds reached.`,
      overrodeModel: modelAction !== 'propose',
      openItems: stillOpen,
    };
  }

  // The model wants to ask a business question. It is the better judge of
  // what it does not understand.
  if (modelAction === 'ask' && modelQuestions.length) {
    return {
      outcome: 'ask_questions',
      questions: modelQuestions.slice(0, 3),
      evidence: none,
      reason: 'The agent needs more information before it can design this.',
      overrodeModel: false,
      openItems: stillOpen,
    };
  }

  // The model wants data. Allowed only if it is NOT re-asking for something
  // already supplied or already declined — repeating a request the user has
  // said they cannot meet is the behaviour this guards against.
  if (modelAction === 'request_evidence' && modelEvidence?.length) {
    const fresh = modelEvidence.filter((e) => !evidenceAlreadyHandled(e, brief));
    if (fresh.length) {
      return {
        outcome: 'request_evidence',
        questions: [],
        evidence: fresh.slice(0, 3),
        reason: 'The agent has asked for data that would materially improve the design.',
        overrodeModel: false,
        openItems: stillOpen,
      };
    }
    // Everything it wants has already been asked for. Do not ask again.
    return {
      outcome: 'ready_for_strategy',
      questions: [],
      evidence: none,
      reason: 'The data the agent wanted has already been requested, so it will work with what is available.',
      overrodeModel: true,
      openItems: stillOpen,
    };
  }

  const blocking = stillOpen.filter(isBlockingItem);

  // DISCOVERY FIRST. Checked before the blocking-item rule below, because an
  // unfinished investigation is not a recommendation with a caveat — there is
  // nothing to recommend yet, so no strategy is surfaced at all.
  //
  // Deliberately NOT applied when the limit is reached or the user asked to
  // proceed: both short-circuit above, so progression always beats
  // enforcement and the agent can never trap someone in discovery.
  //
  // The application decides THAT discovery continues. It never writes the
  // questions — those stay the model's, which is the same boundary the rest
  // of this file keeps.
  const answeredARound = userHasRespondedOnce(brief);
  // A strategy that cannot say what success means has not finished discovery,
  // however tidy its dimension record looks. Deliberately NOT a round count:
  // the rule is that the material question is resolved or explicitly handled.
  const successSettled = successCriteriaSettled(brief);
  // THE TWO FINDINGS. A campaign to raise conversion cannot be designed
  // without knowing who converts today and why the rest do not — those are the
  // audience and the intervention respectively, and the agent asked for
  // neither across 35 recorded runs. It asked instead about KYC completeness
  // and whether a prior EMI Request exists, because a catalogue of filterable
  // attributes was the only material it had.
  //
  // Both are checked here rather than requested in the prompt, for the reason
  // the rest of this file exists: the model's claim to have finished is not
  // the test. A barrier only counts once it traces to something the manager
  // said — see `recordBarriers`, which downgrades an invented one — so this
  // cannot be satisfied by the agent writing down its own guess.
  const knowsConverters = convertersSettled(brief.converters);
  const usableBarriers = designableBarriers(brief.barriers);
  if (
    !isRefinement &&
    (!answeredARound || !successSettled || !knowsConverters || !usableBarriers.length || !discoveryIsComplete(brief))
  ) {
    const open = outstandingDimensions(brief);
    // NEVER A DEAD END.
    //
    // `blocking` comes from the agent's own open items, and on a turn where it
    // tried to propose there are usually none — so this returned
    // `questions: []` and the user got a refusal with nothing to answer. The
    // conversation stopped dead at exactly the moment it needed to continue.
    //
    // The application still does not WRITE the agent's questions; it carries
    // the agent's own where they exist. What it does now is guarantee that a
    // refusal always leaves something to respond to, naming the specific thing
    // that is missing. Giving up is not one of the outcomes.
    const fallbackQuestion = !answeredARound
      ? null
      : !successSettled
        ? 'How would you judge whether this campaign worked?'
        : !knowsConverters
          ? 'Who tends to do this already today — is there any pattern you have noticed, even a rough one?'
          : !usableBarriers.length
            ? 'In your own words, what do you think is stopping them? An honest "I am not sure" is a useful answer.'
            : null;
    const carried = blocking.slice(0, 3).map((i) => asQuestion(i.question));
    return {
      outcome: 'continue_discovery',
      questions: carried.length ? carried : fallbackQuestion ? [asQuestion(fallbackQuestion)] : [],
      evidence: none,
      reason: !answeredARound
        ? 'I jumped to a strategy without asking you anything first. Let me put the questions to you instead.'
        : !successSettled
        ? 'I still do not know how you would judge whether this worked, and that changes who the campaign should go after.'
        : !knowsConverters
        ? 'I do not yet know who does this today, so I cannot say who the campaign should go after.'
        : !usableBarriers.length
        ? 'I do not yet know what is stopping them, so there is nothing for the campaign to work on.'
        : briefDimensions(brief).length === 0
          ? 'I moved to a strategy without setting out what I had considered along the way.'
          // Something still OPEN is reported first: it is the most actionable
          // thing to say, and it stays true whether or not enough lines of
          // enquiry have been raised yet.
          : open.length
            ? `Still working through: ${open.map((d) => d.name).join(', ')}.`
            : briefDimensions(brief).length < MIN_DIMENSIONS_CONSIDERED
              ? `I have only looked at ${briefDimensions(brief).length} angle(s) so far. Being confident about one is not the same as having weighed the alternatives, so let me keep going.`
              : `I raised these and then let them go without saying why: ${droppedWithoutReason(brief).map((d) => d.name).join(', ')}. Ruling something out is a decision, so it needs a reason.`,
      overrodeModel: true,
      openItems: stillOpen,
    };
  }

  // The model proposed and discovery is done. The strategy is KEPT either way
  // — the only question left is whether anything material also needs putting
  // to the user.
  //
  // What changed: a material gap used to convert the whole turn into
  // questions, and the orchestrator then returned with strategy and blueprint
  // null. The recommendation was destroyed by the act of being honest about
  // its own limits. Now the gap and the recommendation travel together.
  if (blocking.length > 0) {
    return {
      outcome: 'strategy_with_questions',
      questions: blocking.slice(0, 3).map((i) => asQuestion(i.question)),
      evidence: none,
      reason:
        'The agent has recommended a strategy. These points could still change it, so they are worth answering before the campaign is built.',
      overrodeModel: false,
      openItems: stillOpen,
    };
  }

  // Nothing blocking left. Evidence gaps, preferences and limitations are
  // carried into the strategy rather than asked.
  const noted = stillOpen.length;
  return {
    outcome: 'ready_for_strategy',
    questions: [],
    evidence: none,
    reason: noted
      ? 'The remaining points are things the agent would like to know but does not need, so it has proposed a baseline and stated them.'
      : brief.answers.length
        ? 'Your answers resolved the material uncertainties.'
        : 'The brief and the retrieved context were sufficient.',
    overrodeModel: false,
    openItems: stillOpen,
  };
}

// isEvidenceGap and isAnsweredByContext used to live here. Both are gone, and
// neither is coming back in another form:
//
//   isEvidenceGap classified an open item as blocking or not from its
//   wording. Measured against real strings it was wrong in both directions —
//   "the exact message copy and CTA wording" came out material and blocked a
//   campaign, "the optimal number of reminders" came out as mere evidence.
//   The model now states the kind itself (OpenItemKind).
//
//   isAnsweredByContext suppressed a question when enough of its words
//   appeared anywhere in the retrieved context. Because the vocabulary block
//   enumerates every event category and entity, "should the entry be a
//   Transaction event or an EMI Request event?" matched 4 of 4 words and was
//   silently dropped — the one question that would have prevented the EMI
//   failure. Appearing in a list is not the same as having a value, so
//   nothing is retired by context any more. Only the user retires a question,
//   by answering it.

/** Has this data already been requested, supplied, or declined? */
function evidenceAlreadyHandled(
  candidate: { question: string; fields: string[] },
  brief: WorkingBrief,
): boolean {
  const words = new Set(fingerprint(`${candidate.question} ${candidate.fields.join(' ')}`).split(' ').filter(Boolean));
  if (!words.size) return false;
  return brief.evidenceRequests.some((prior) => {
    const other = new Set(fingerprint(`${prior.question} ${prior.fields.join(' ')}`).split(' ').filter(Boolean));
    const shared = [...words].filter((w) => other.has(w)).length;
    return shared / words.size >= 0.4;
  });
}

/**
 * Phrases an open item as a question. The model may write it either way, so a
 * statement becomes a question and a question is left alone.
 */
function asQuestion(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.endsWith('?')) return t;
  const lead = /^(whether|if|what|which|how|when|who|the exact|the precise)\b/i.test(t);
  const body = t.replace(/[.;]+$/, '');
  return lead ? `Can you confirm ${body.charAt(0).toLowerCase()}${body.slice(1)}?` : `${body} — can you confirm?`;
}

/**
 * Has this already been put to the user, or addressed by something the user
 * said? Word-overlap, because the model rarely repeats an open item verbatim
 * and the same thing must not be asked twice.
 *
 * The corpus is deliberately narrow: questions WE asked, and answers the USER
 * gave. Retrieved context is not in it and must never be — that conflation is
 * what isAnsweredByContext got wrong. A value exists because a person stated
 * it, not because the word appears in a capability listing.
 */
function alreadyCovered(uncertainty: string, brief: WorkingBrief): boolean {
  const words = new Set(fingerprint(uncertainty).split(' ').filter(Boolean));
  if (!words.size) return true;
  const corpus = [
    ...brief.questions.map((q) => q.text),
    ...brief.answers.map((a) => a.text),
    // Only CONFIRMED facts count. An assumption the agent recorded is not an
    // answer, and must not retire the question it was assumed for.
    ...brief.facts.filter((f) => (f.confidence ?? 'confirmed') === 'confirmed').map((f) => f.statement),
    // Data we already asked for and the user answered or declined. Re-raising
    // it as a question would be the same request wearing a different hat.
    ...brief.evidenceRequests.filter((e) => e.status !== 'pending').map((e) => e.question),
  ];
  return corpus.some((text) => {
    const other = new Set(fingerprint(text).split(' ').filter(Boolean));
    const shared = [...words].filter((w) => other.has(w)).length;
    return shared / words.size >= 0.4;
  });
}

/**
 * Records an answer against the brief and re-opens the next round.
 *
 * The answer is also written as a CONFIRMED fact, carrying the ids of the
 * questions it settled. That is what lets the gate tell "the user told us
 * this" apart from "we assumed this", without inspecting wording.
 */
export function recordAnswer(brief: WorkingBrief, answer: string): WorkingBrief {
  const round = brief.rounds;
  const settled = brief.questions.filter((q) => q.answeredInRound === undefined).map((q) => q.id);
  return {
    ...brief,
    answers: [...brief.answers, { round, text: answer }],
    questions: brief.questions.map((q) => (q.answeredInRound === undefined ? { ...q, answeredInRound: round } : q)),
    facts: [
      ...brief.facts,
      { statement: answer, source: 'user-answer', round, confidence: 'confirmed', answers: settled },
    ],
  };
}

/** Records the questions actually put to the user. */
export function recordQuestions(
  brief: WorkingBrief,
  questions: (string | { text: string; impact?: QuestionImpact; contingency?: unknown })[],
): WorkingBrief {
  const round = brief.rounds + 1;
  return {
    ...brief,
    rounds: round,
    questions: [
      ...brief.questions,
      ...questions.map((text, i) => ({
        id: `q${round}-${i}`,
        text: typeof text === 'string' ? text : text.text,
        askedInRound: round,
        ...(() => {
          const impact = typeof text === 'string' ? undefined : asImpact(text.impact);
          return impact ? { impact } : {};
        })(),
        // Parsed here, where `impact` already is. The last time a field was
        // accepted from the model and plumbed separately it was silently
        // dropped on the floor at all three call sites, and I reported the
        // model as not emitting it — it was emitting it and the application
        // was discarding it. One place, same place.
        ...(() => {
          const c = typeof text === 'string' ? undefined : asContingency(text.contingency);
          return c ? { contingency: c } : {};
        })(),
      })),
    ],
  };
}

/**
 * Keeps only a contingency with all five parts present as strings.
 *
 * A partial one is discarded rather than patched, so a half-filled shape can
 * never read as a satisfied requirement — `checkContingency` then reports it
 * as missing, which is the honest outcome.
 */
export function asContingency(v: unknown): QuestionContingency | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const keys = ['ifA', 'thenA', 'ifB', 'thenB', 'ifUnknown'] as const;
  if (!keys.every((k) => typeof o[k] === 'string' && (o[k] as string).trim())) return undefined;
  return {
    ifA: String(o.ifA).trim(), thenA: String(o.thenA).trim(),
    ifB: String(o.ifB).trim(), thenB: String(o.thenB).trim(),
    ifUnknown: String(o.ifUnknown).trim(),
  };
}

/** Records the data actually requested, so it is never asked for twice. */
export function recordEvidenceRequests(
  brief: WorkingBrief,
  requests: Omit<EvidenceRequest, 'id' | 'askedInRound' | 'status'>[],
): WorkingBrief {
  const round = brief.rounds + 1;
  return {
    ...brief,
    rounds: round,
    evidenceRequests: [
      ...brief.evidenceRequests,
      ...requests.map((r, i) => ({ ...r, id: `e${round}-${i}`, askedInRound: round, status: 'pending' as const })),
    ],
  };
}

/**
 * Words that mean "I can't give you that". Checked against an answer to a
 * pending evidence request, so the agent stops asking and states the
 * limitation instead.
 */
const DECLINE_PATTERNS = [
  /\bdon'?t have\b/i, /\bdo not have\b/i, /\bnot available\b/i,
  // Allows words between "no" and "data" — a live run said "no historical
  // conversion data at all", which a fixed prefix list did not match.
  /\bno\b[^.!?]{0,40}\bdata\b/i, /\bnone\b[^.!?]{0,30}\b(data|available)\b/i,
  /\bcan'?t (get|provide|share)\b/i, /\bcannot (get|provide|share)\b/i, /\bunavailable\b/i,
  /\bwe don'?t track\b/i, /\bnot tracked\b/i, /\bno access\b/i, /\bskip\b/i, /\bproceed without\b/i,
  /\bnot measured\b/i, /\bnever measured\b/i,
];

export function readsAsDecline(text: string): boolean {
  return DECLINE_PATTERNS.some((re) => re.test(text));
}

/**
 * Resolves pending evidence requests against the user's reply.
 *
 * A decline is recorded as a LIMITATION, not a failure: the strategy proceeds
 * and says what it could not check. This is the difference between an agent
 * that adapts and one that nags.
 */
export function resolveEvidence(brief: WorkingBrief, answer: string): WorkingBrief {
  const pending = brief.evidenceRequests.filter((e) => e.status === 'pending');
  if (!pending.length) return brief;

  const declined = readsAsDecline(answer);
  const limitations = [...brief.limitations];
  const evidenceRequests = brief.evidenceRequests.map((e) => {
    if (e.status !== 'pending') return e;
    if (declined) {
      limitations.push(
        `${e.question} — not available, so the strategy does not rely on it. ${e.wouldInform}`,
      );
      return { ...e, status: 'unavailable' as const };
    }
    return { ...e, status: 'supplied' as const, suppliedSummary: answer.slice(0, 400) };
  });

  return {
    ...brief,
    evidenceRequests,
    limitations,
    facts: declined
      ? brief.facts
      : [...brief.facts, { statement: answer.slice(0, 300), source: 'user-answer' as const, round: brief.rounds }],
  };
}

/**
 * Records a volunteered "we have no data" even when nothing was formally
 * requested.
 *
 * A live run surfaced this: the user said "we have no historical conversion
 * data at all" in a normal answer, the agent correctly stopped relying on it
 * — but nothing was written to `limitations`, so the strategy carried the
 * constraint only in prose. Now it is captured either way.
 */
/**
 * Does a decline refer to missing DATA, as opposed to declining something
 * else ("skip the experiment")? A narrow test on a sentence the USER wrote,
 * not a judgement about how important a question is — that distinction is why
 * this survives while isEvidenceGap did not.
 */
const mentionsData = (text: string) =>
  /\b(data|figures|numbers|stats|statistics|metrics?|history|historical|records|benchmarks?|rates?)\b/i.test(text);

export function noteVolunteeredLimitation(brief: WorkingBrief, answer: string): WorkingBrief {
  if (!readsAsDecline(answer)) return brief;
  if (!mentionsData(answer)) return brief;
  const note = `Stated as unavailable by the user: ${answer.slice(0, 200)}`;
  if (brief.limitations.some((l) => fingerprint(l) === fingerprint(note))) return brief;
  return { ...brief, limitations: [...brief.limitations, note] };
}

/** Adds confirmed facts to the brief without discarding anything earlier. */
export function recordFacts(brief: WorkingBrief, facts: BriefFact[]): WorkingBrief {
  const existing = new Set(brief.facts.map((f) => fingerprint(f.statement)));
  return {
    ...brief,
    facts: [...brief.facts, ...facts.filter((f) => !existing.has(fingerprint(f.statement)))],
  };
}

/**
 * Records how the business would judge success, additively.
 *
 * Reuses `brief.successCriteria`, which already existed and was never written
 * to. Deduplicated on exact text so a restatement does not accumulate.
 */
/**
 * Records how success is to be judged, REPLACING any earlier statement of it.
 *
 * THE DEFECT, measured on a live run: this appended, deduplicating only on an
 * exact lowercase match. The model restates the objective on every propose
 * turn, slightly reworded each time, so the list grew — by turn five it held
 * "this is ongoing optimisation, not tied to a campaign cycle" AND "this is
 * ongoing, open-ended optimisation, not tied to a campaign cycle", which the
 * user then read back as two separate criteria.
 *
 * The tempting fix is fuzzy matching. That is a guess dressed as a rule, and
 * one day it merges two criteria that genuinely differ with nobody noticing.
 * The real problem is that there is ONE definition of success and this was
 * modelled as an append-only list. A later statement supersedes the earlier
 * one, which is both simpler and actually true.
 *
 * An empty or all-blank payload changes nothing: silence is not a retraction,
 * and a turn that simply does not mention success must not erase it.
 */
export function recordSuccessCriteria(brief: WorkingBrief, items: string[]): WorkingBrief {
  const next = items.map((i) => i.trim()).filter(Boolean);
  if (!next.length) return brief;
  const same =
    (brief.successCriteria ?? []).length === next.length &&
    (brief.successCriteria ?? []).every((c, i) => c === next[i]);
  return same ? brief : { ...brief, successCriteria: next };
}

// ------------------------------------------------------- customer findings

/**
 * Does a claimed quote actually appear in what the user typed?
 *
 * THE PROBLEM THIS SOLVES. `basis: 'user-belief'` is a label the model
 * applies to itself. Nothing stopped it inventing a reason customers do not
 * convert, crediting the manager with it, and building a campaign on the
 * result — which is indistinguishable, afterwards, from the manager having
 * actually said it. Dimensions have carried this weakness since they were
 * added; the prompt asks the model to be honest about it and that is all.
 *
 * A quote is checkable. The manager's words are in `brief.answers`, so the
 * claim can be tested instead of trusted.
 *
 * Matched on significant-word overlap rather than as a substring, because a
 * model quoting from a conversation reliably paraphrases — it drops filler,
 * fixes the grammar and changes the tense. Demanding a literal substring
 * would reject honest attributions far more often than dishonest ones, which
 * would make the check worse than nothing. The threshold is deliberately
 * low: the question is whether this came from the user at all, not whether
 * it was transcribed well.
 */
/**
 * Words that turn a repetition into a rejection.
 *
 * The thing that makes a quote check hard: a manager correcting the agent
 * REPEATS the agent's theory in order to deny it. "I did not say they tune
 * out repeated pings" contains the phrase verbatim, so contiguity alone
 * verifies the very barrier the sentence exists to reject.
 *
 * Checked only in the text BEFORE the match and only within its own
 * sentence, so a barrier that is itself about an absence still verifies:
 * quoting "they do not know how to set the PIN" has nothing in front of it.
 */
const DENIAL = /\b(not|never|didn|dont|doesn|isnt|wasnt|no|nothing|wrong|rather|instead|besides)\b/;

/** Joining words, which say nothing about whether this is their sentence. */
const FILLER = new Set([
  'the','a','an','is','are','was','were','be','to','of','for','and','or','in','on','at','it','that','this',
  'they','them','their','we','our','you','your','i','my','as','so','but','if','then','than','with','from',
  'do','does','did','has','have','had','will','would','can','could','may','might','just','very','really',
]);

/** Lowercase, punctuation to spaces, whitespace collapsed. */
const flatten = (text: string): string =>
  String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Did the manager actually say this?
 *
 * IT HAS TO BE A PHRASE THEY TYPED. This was 40% word overlap against
 * everything they had ever written, which in a long conversation is nearly
 * free: "customers tune out repeated pings" shares `customers`, `repeated`
 * and `pings` with a dozen unrelated sentences about an EMI campaign. The
 * agent's own rival theories cleared it, were upgraded to `user-belief`, and
 * came back at the manager as "You told me" — blocking a build they had
 * approved with words they had never said.
 *
 * So: a contiguous run of their words, or a near-miss over a window of the
 * same length — a paraphrase of ONE sentence, not a bag of words drawn from
 * the whole transcript.
 *
 * THE UPGRADE IT GUARDS IS DELIBERATE AND STAYS. A barrier labelled
 * `assumption` that carries the manager's actual words is their belief
 * whatever the label said, and refusing to hear it once deadlocked the gate
 * for eight turns. What changes is the standard of evidence, not the rule.
 *
 * Failing here only ever RELEASES: the barrier stays an assumption, which
 * `mustBeAddressed` now excludes, so a false negative costs an obligation
 * rather than creating one.
 *
 * KNOWN RESIDUAL. Words that happen to coincide INSIDE one of their
 * sentences can still pass — "we push pings out on repeated occasions"
 * against "customers tune out repeated pings". That is a far smaller surface
 * than the whole transcript and it needs the manager to have written a
 * near-collision by accident. Tightening further starts rejecting honest
 * paraphrases, which is the more expensive mistake: the record then carries
 * the agent's label instead of the manager's own belief.
 */
function quoteIsTheirs(quote: string, brief: WorkingBrief): boolean {
  const q = flatten(quote).split(' ').filter(Boolean);
  // Two words match something in any conversation. A quote that short is not
  // evidence of anything.
  if (q.length < 3) return false;

  // Answers AND supplied evidence, because both are things the user typed.
  //
  // The orchestrator resolves an evidence request WITHOUT calling
  // recordAnswer — the reply lands in `suppliedSummary` instead — so keying
  // on `answers` alone would reject an attribution to something the user
  // genuinely said, just because they said it in reply to a data request
  // rather than a question. A DECLINED request contributes nothing,
  // correctly: "we don't have that" is not a statement about why customers
  // behave as they do.
  const corpus = [
    ...brief.answers.map((a) => a.text),
    ...brief.evidenceRequests.filter((e) => e.status === 'supplied').map((e) => e.suppliedSummary ?? ''),
  ];

  for (const text of corpus) {
    // Sentence by sentence, so a denial in one cannot be escaped by a
    // coincidence in the next.
    for (const sentence of String(text ?? '').split(/[.!?;\n]+/)) {
      const said = flatten(sentence).split(' ').filter(Boolean);
      if (said.length < q.length) continue;
      // Windows a little wider than the quote, so an inserted word — "far
      // too expensive" against "too expensive" — does not throw the
      // alignment off. Still one short span of their sentence, never the
      // whole transcript.
      for (let width = q.length; width <= q.length + 2; width++) {
        for (let i = 0; i + width <= said.length; i++) {
          const window = new Set(said.slice(i, i + width));
          // Content words only. A model quoting a conversation drops filler
          // and fixes grammar — "the interest looks too expensive to them"
          // for "they think the interest is too expensive" — and scoring the
          // joining words would reject honest attributions more often than
          // dishonest ones.
          //
          // The tightening that matters is not this threshold: it is that
          // the match must fall inside ONE SENTENCE they wrote. The old
          // check scored against every word in the transcript at once, which
          // is how an invented theory borrowed `customers`, `repeated` and
          // `pings` from three unrelated sentences and passed.
          const content = q.filter((w) => !FILLER.has(w));
          const scored = content.length ? content : q;
          const shared = scored.filter((w) => window.has(w)).length;
          if (shared / scored.length < 0.6) continue;
          // …unless their sentence denies it up to that point. Words that
          // are part of the quote are excluded from this test, so a barrier
          // ABOUT an absence — "they do not know how to set the PIN" — still
          // verifies on its own words, while "I did not say they tune out"
          // does not.
          const lead = said.slice(0, i + width).filter((w) => !q.includes(w));
          if (DENIAL.test(lead.join(' '))) continue;
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Record who converts today.
 *
 * Replaces rather than accumulates, like `recordSuccessCriteria`: there is
 * one answer to "who converts", and a later round correcting it should
 * supersede the earlier one rather than sit alongside it.
 */
export function recordConverters(brief: WorkingBrief, c: Converters | null | undefined): WorkingBrief {
  if (!c || typeof c.shape !== 'string' || !c.shape.trim()) return brief;
  const basis: FindingBasis = (['user', 'user-belief', 'assumption', 'none'] as const).includes(
    c.basis as FindingBasis,
  )
    ? c.basis
    : 'assumption';
  const knowledge: ConverterKnowledge = (['known', 'none-yet', 'unknown'] as const).includes(
    c.knowledge as ConverterKnowledge,
  )
    ? c.knowledge
    : 'unknown';
  const candidates = (c.candidates ?? [])
    .filter((s) => s && typeof s.segment === 'string' && typeof s.restsOn === 'string' && typeof s.why === 'string')
    .map((s) => ({ segment: s.segment.trim(), restsOn: s.restsOn.trim(), why: s.why.trim() }))
    .filter((s) => s.segment && s.restsOn && s.why);

  // `raisedInRound` is stamped by the APPLICATION, never taken from the model.
  //
  // It is the thing that distinguishes "the agent proposed segments" from
  // "the manager had a chance to respond to them", and letting the model
  // supply it would let it claim its own suggestion had already been agreed.
  // Set once, on the round the candidates first appear, and preserved after:
  // re-sending the same candidates must not reset the clock and wipe out the
  // reply that already came back.
  const had = brief.converters?.candidates?.length ?? 0;
  const raisedInRound = candidates.length
    ? had
      ? brief.converters?.raisedInRound ?? brief.rounds
      : brief.rounds
    : undefined;

  return {
    ...brief,
    converters: { shape: c.shape.trim(), basis, knowledge, candidates, raisedInRound },
  };
}

/**
 * Which of its own questions the model says a reply did NOT cover.
 *
 * The inverse of `recordAddressedQuestions`, and the one the orchestrator
 * uses. It writes the SAME field — `addressedInRound` remains the only record
 * of whether a question has been dealt with — so nothing downstream changes.
 * What changes is the DEFAULT, and only for the questions where the default is
 * safe.
 *
 * WHY. The positive form was set only when the model emitted an `answered`
 * array. A model that left the field out therefore produced a brief in which
 * nothing had been answered, and the application told a campaign manager
 * "your reply did not cover it" about an answer they had plainly given, then
 * asked again. The common case — a reply that answers — must not depend on an
 * optional field arriving.
 *
 * IT NO LONGER STOPS AT FORKS. It did until 2026-10-21, on the asymmetry that
 * a wrongly-discharged detail loses a nuance while a wrongly-discharged fork
 * builds the wrong campaign. The asymmetry is real; the conclusion drawn from
 * it was not. Keeping forks open by default did not make the application
 * careful, it made it unable to hear an answer: the manager replied to both
 * forks, the model's own prose read them back correctly, and because it did
 * not also emit `answered` the screen re-asked both. Three turns, five
 * questions on screen, nothing built.
 *
 * `notCovered` is the protection now, and it is the better one — it is the
 * model stating that a specific question went untouched, which is a claim
 * about this reply, rather than a standing default that treats every reply as
 * insufficient until proven otherwise.
 *
 * Applied on EVERY turn, including with an empty list: the empty list IS the
 * claim that nothing went uncovered.
 */
export function recordUncoveredQuestions(brief: WorkingBrief, uncovered: string[] | undefined): WorkingBrief {
  const skipped = new Set((uncovered ?? []).map((i) => i.trim()).filter(Boolean));
  return {
    ...brief,
    questions: brief.questions.map((q) => {
      // Not yet replied to at all. A question asked this very turn has no
      // reply to have covered it.
      if (q.answeredInRound === undefined) return q;
      if (q.addressedInRound !== undefined) return q;
      if (skipped.has(q.id)) return q;
      // FORKS ARE ADDRESSED BY A REPLY TOO, since 2026-10-21.
      //
      // They used to be excepted: a fork stayed open unless the model
      // explicitly claimed it in `answered`. The intent was sound — a
      // wrongly-discharged fork builds the wrong campaign silently — but it
      // was paid for with the failure that actually costs trust. Measured
      // live: the manager replied "1. PIN setting 2. more cardholders
      // activate", the model's own prose confirmed both were settled, and
      // because it did not emit `answered` the record kept both forks open
      // and the screen asked them again. Twice more.
      //
      // A reply answers what was asked. The protection against discharging a
      // fork by inference is `notCovered` above — the model saying so — not a
      // default that treats every reply as insufficient.
      return { ...q, addressedInRound: brief.rounds };
    }),
  };
}

/**
 * Record the reasons customers do not convert, merged by id.
 *
 * Merge-by-id mirrors `recordDimensions`: a later round may change a
 * barrier's lever without restating its wording, and whatever it omits must
 * survive rather than be blanked.
 *
 * THE ATTRIBUTION DOWNGRADE is the part that matters. A barrier claiming the
 * manager said it, whose quote does not appear in anything the manager
 * typed, is recorded as `assumption` instead — the agent's own guess, which
 * `isDesignable` will not let a campaign rest on. Nothing is thrown away and
 * nothing errors: the barrier stays, the claim about where it came from does
 * not, and the agent reads the corrected record on its next round. That is
 * the same self-correcting shape as `asFindingOrDeferral`.
 */
export function recordBarriers(brief: WorkingBrief, updates: Barrier[] | undefined): WorkingBrief {
  // MERGED BY ID. A SENT LIST UPDATES WHAT IT NAMES AND KEEPS WHAT IT DOES
  // NOT.
  //
  // THIS REPLACED THE WHOLE LIST UNTIL 2026-10-23, and the reasoning behind
  // that is kept because it was not silly: the agent floated rival theories
  // early — message fatigue, first-time versus repeat EMI — narrowed to one,
  // and the discarded two stayed on the record and blocked the build for not
  // being addressed. The prompt asks for barriers on EVERY turn, so a sent
  // list reads as the agent's current position rather than an increment.
  //
  // MEASURED, end to end, in `eval/runs/ui-s-1792735473522/turns/turn-3.json`.
  // The manager said customers do not realise the purchase qualifies; that
  // went in as `awareness-gap`. `propose_strategy` then refused the plan for
  // citing one barrier twice and instructed the agent to record a second
  // explanation. It did — in a call carrying ONLY the invented rival — and
  // replace-on-sent deleted the manager's own barrier. The brief ended the
  // turn holding one assumption the agent had made up, and nothing the
  // manager had said.
  //
  // Replacement cannot tell "I withdraw the others" from "here is one more",
  // and the second reading is the common one. The stale-rival problem it was
  // solving is real but smaller, has an explicit instrument already —
  // `lever: 'not-addressable'` answers a barrier without designing for it —
  // and costs a stated limitation rather than the manager's own words.
  //
  // Empty or omitted still means "do not touch", unchanged.
  if (!updates?.length) return brief;
  // Start from what is already recorded. An update NAMES what it changes; a
  // barrier it does not mention is carried untouched, and one it re-sends
  // keeps any field the update did not repeat — terseness is not retraction,
  // and the quote is the record of what the manager actually said.
  const prior = brief.barriers ?? [];
  const out: Barrier[] = [...prior];

  for (const raw of updates) {
    if (!raw || typeof raw.statement !== 'string' || !raw.statement.trim()) continue;
    const id = (raw.id || fingerprint(raw.statement).split(' ').slice(0, 3).join('-')).trim();
    if (!id) continue;

    // THE QUOTE DECIDES, NOT THE LABEL. Both directions.
    //
    // Downgrade is the obvious half: a barrier claiming the manager said it,
    // whose quote appears nowhere in what they typed, is the agent's own
    // invention wearing their name.
    //
    // PROMOTION is the half that was missing, and leaving it out deadlocked a
    // whole run. The agent sent `basis: 'assumption'` with the quote "my
    // guess is they see the interest and think it is too expensive" — the
    // manager's exact words. It had classified an honest guess as an
    // assumption, which is a defensible reading of the word and fatal here:
    // `isDesignable` rejects 'assumption', so the gate blocked for ever on a
    // barrier that was perfectly well evidenced. Eight turns, no proposal.
    //
    // A verified quote IS the evidence. 'user-belief' exists precisely for
    // "their conjecture about why customers behave as they do", so a barrier
    // carrying their actual words belongs there whatever label arrived with
    // it. The application should not require the model to win a vocabulary
    // argument in order to be heard.
    const verified = !!raw.quote && quoteIsTheirs(raw.quote, brief);
    const claimsUser = raw.basis === 'user' || raw.basis === 'user-belief';
    const basis: FindingBasis = verified
      ? (raw.basis === 'user' ? 'user' : 'user-belief')
      : claimsUser
        ? 'assumption'
        : (raw.basis ?? 'assumption');

    const lever: BarrierLever = (['message', 'timing', 'targeting', 'not-addressable'] as const).includes(
      raw.lever as BarrierLever,
    )
      ? raw.lever
      : 'message';

    const was = prior.find((b) => b.id.toLowerCase() === id.toLowerCase());
    const at = out.findIndex((b) => b.id.toLowerCase() === id.toLowerCase());
    const merged: Barrier = { ...(was ?? {}), ...(out[at] ?? {}), id, statement: raw.statement.trim(), basis, lever };
    if (raw.quote) merged.quote = raw.quote;
    if (at >= 0) out[at] = merged;
    else out.push(merged);
  }

  return { ...brief, barriers: out };
}

/** The barriers on this brief, defaulted for a brief persisted before they existed. */
export const briefBarriers = (brief: WorkingBrief): Barrier[] => brief.barriers ?? [];

/**
 * Has the business measure of success been settled, one way or the other?
 *
 * "Explicitly handled" counts: a recorded criterion saying the user has no
 * target yet IS a settled working definition. What does not count is silence.
 * This is deliberately a presence check and not a text check — the lexical
 * route was measured as unreliable elsewhere in this file.
 */
export const successCriteriaSettled = (brief: WorkingBrief): boolean =>
  (brief.successCriteria ?? []).length > 0;

/**
 * Records which sources were consulted, deduplicated by source name.
 *
 * Reuses `brief.contextChecked`, which existed and was never written to. The
 * point is that a claim of having checked something becomes part of the record
 * the user can see, rather than a sentence in prose that nobody can audit.
 */
export function recordContextChecked(
  brief: WorkingBrief,
  items: { source: string; found: boolean }[],
): WorkingBrief {
  const have = new Map((brief.contextChecked ?? []).map((c) => [c.source.trim().toLowerCase(), c]));
  for (const i of items) {
    const key = i.source?.trim().toLowerCase();
    if (!key) continue;
    // A later "found" wins: a source checked twice, once fruitlessly, counts
    // as found if anything turned up either time.
    const prev = have.get(key);
    have.set(key, { source: prev?.source ?? i.source.trim(), found: Boolean(prev?.found) || Boolean(i.found) });
  }
  return { ...brief, contextChecked: [...have.values()] };
}

/** Every dimension recorded so far. Defaults, so an older brief is safe. */
export const briefDimensions = (brief: WorkingBrief): DiscoveryDimension[] => brief.dimensions ?? [];

/**
 * Dimensions still being investigated.
 *
 * Only 'open' counts as unresolved. 'deferred' and 'unavailable' are
 * DECISIONS — "we looked and chose not to pursue this" and "the platform
 * cannot express this" — and treating either as a gap would block a campaign
 * for ever on something that can never be resolved. That is exactly the OS
 * amount case: no outstanding-balance attribute exists on any entity, so it
 * can only ever be disclosed, never answered.
 */
export const outstandingDimensions = (brief: WorkingBrief): DiscoveryDimension[] =>
  briefDimensions(brief).filter((d) => d.status === 'open');

/**
 * Has discovery actually happened?
 *
 * Two conditions, and the first is the one that matters: SOMETHING must have
 * been considered. An empty record is not a clean bill of health, it is the
 * absence of an investigation — and it is indistinguishable, from the
 * application's side, from an agent that went straight to a design.
 */
/**
 * How many lines of enquiry must have been RAISED before a strategy lands.
 *
 * Three, because one is not an investigation. The agent may well be certain
 * about a single factor — but being certain about one thing is not the same
 * as having considered the alternatives, and a campaign built on the first
 * plausible idea is the thing this whole gate exists to prevent. The prompt
 * has always asked for three to five; the gate accepted one, so nothing made
 * it true.
 */
export const MIN_DIMENSIONS_CONSIDERED = 3;

/**
 * Has the investigation actually happened?
 *
 * Three conditions, and the third is the one that was missing:
 *
 *  1. Enough lines of enquiry were RAISED. See above.
 *  2. None is still open — anything named has been resolved.
 *  3. Anything NOT carried into the design says why it was ruled out.
 *
 * (3) is what makes this "ask and rule out" rather than "ask and drop".
 * `deferred` and `unavailable` are legitimate endings — plenty of factors
 * turn out not to matter, or cannot be established — but each has to leave a
 * reason behind. A dimension that was raised and then silently dropped is
 * indistinguishable from one that was never thought about, and it is exactly
 * how a campaign ends up resting on the first idea anybody had.
 *
 * `retained` needs no note: it is in the design, where its reasoning shows.
 */
export const discoveryIsComplete = (brief: WorkingBrief): boolean => {
  const dims = briefDimensions(brief).filter((d) => !isPlatformDimension(d.name));
  if (dims.length < MIN_DIMENSIONS_CONSIDERED) return false;
  if (outstandingDimensions(brief).length > 0) return false;
  return dims.every((d) => d.status === 'retained' || (d.note ?? '').trim().length > 0);
};

/** Raised, not carried into the design, and never said why. */
export const droppedWithoutReason = (brief: WorkingBrief): DiscoveryDimension[] =>
  briefDimensions(brief).filter((d) => d.status !== 'retained' && !(d.note ?? '').trim());

/**
 * Has the user actually taken part yet?
 *
 * WHY THIS EXISTS, measured live: with the dimension record alone, the agent
 * closed all five dimensions inside its FIRST turn — two of them on nothing
 * but an assumption — and proposed a campaign with `answers: []`. The record
 * was complete and the gate had no grounds to refuse, because the model
 * supplies both the dimensions and their statuses. Completeness it certifies
 * for itself is not evidence that discovery happened.
 *
 * A reply to an EVIDENCE request counts. The orchestrator resolves evidence
 * without calling `recordAnswer`, so keying on `answers` alone would block a
 * conversation whose only exchange was "we don't have that data" — a real
 * answer, and one the agent is explicitly designed to proceed from.
 */
/**
 * Questions that were asked, drew a reply, and that nothing has claimed the
 * reply actually covered.
 *
 * Deliberately not treated as "unanswered" for loop-safety: they keep their
 * `answeredInRound`, so nothing re-asks them forever. They are surfaced as a
 * decision — re-ask, or proceed and say why — and the orchestrator refuses a
 * proposal that does neither.
 */
/**
 * Asked, a reply arrived, and nothing claimed it covered this one.
 *
 * KNOWN WEAKNESS, measured live and deliberately not fixed by inversion:
 * `addressedInRound` is set only from the model's own `answered` array, so
 * when the model forgets to populate it the application concludes the user
 * did not answer. A manager wrote "1. PIN set up 2. how many new cardholders
 * activate" and was told both questions were uncovered — while the agent's
 * own prose quoted "PIN set" back at them.
 *
 * Inverting the default (silence means answered) is the right long-term fix
 * and was tried: it invalidates the whole of answerAttribution.test.ts, which
 * is 56 tests encoding the current contract, and that is too large a change
 * to land at the end of a session. What IS fixed is the harm: the copy no
 * longer tells the user their reply failed, and the copy no longer
 * implies the user was at fault. The loop itself is still bounded only by
 * MAX_FORK_REFUSALS, which is the part still to fix.
 */
export const unaddressedQuestions = (brief: WorkingBrief): OpenQuestion[] =>
  brief.questions.filter((q) => q.answeredInRound !== undefined && q.addressedInRound === undefined);

/**
 * Unanswered questions the agent itself called a fork.
 *
 * These may not be discharged by writing an assumption. The agent decided,
 * before it had any reason to avoid the answer, that two answers mean two
 * different campaigns — so guessing picks one of them for the user.
 *
 * Measured: the OS-to-EMI run identified "never started a request vs already
 * Pending" as the central fork, never got an answer, inferred Pending from the
 * success measure, and built an entry on EMI_STATUS_CHANGED. The user then
 * said the opposite, and the entry had to change entity, event and audience.
 */
/**
 * How many times one fork may block a proposal before its fallback applies.
 *
 * Two. The first refusal is the agent asking. The second is it asking again
 * having been given a reply that did not cover it. A third would be the
 * application insisting on an answer the user has twice declined to give,
 * which is not a guard any more, it is a deadlock.
 */
export const MAX_FORK_REFUSALS = 2;

/** Forks that still block, and forks whose fallback now applies instead. */
export const unansweredForks = (brief: WorkingBrief): OpenQuestion[] =>
  unaddressedQuestions(brief).filter((q) => isHonouredFork(q) && (q.blockedCount ?? 0) < MAX_FORK_REFUSALS);

/**
 * Forks that have blocked their limit and are now resolved by their own stated
 * default — or, where none was stated, carried forward as live uncertainty.
 *
 * This is the explicit fallback policy. The uncertainty is preserved and said
 * out loud either way; what stops is the repetition.
 */
export const forksFallenBack = (brief: WorkingBrief): OpenQuestion[] =>
  unaddressedQuestions(brief).filter((q) => q.impact === 'fork' && (q.blockedCount ?? 0) >= MAX_FORK_REFUSALS);

/**
 * Dimensions the agent raised and then walked away from.
 *
 * MEASURED: a proposal arrived on turn 3 with "What is currently stopping
 * customers from converting" sitting at basis `none` — the single question the
 * whole campaign turns on, named by the agent itself, never investigated, and
 * designed around anyway. Nothing stopped it, because deferring was free: the
 * gate checks forks, dropped questions and untreated beliefs, and nothing ever
 * asked whether the agent had resolved what it raised.
 *
 * `none` is the only illegal state here, and it means exactly one thing: named
 * it, walked away. Every other basis is a real answer about where the dimension
 * stands — ask the user (`user`), check the platform (`tool`), state the
 * default you are proceeding under (`assumption`), or record it as their
 * untested belief (`user-belief`).
 *
 * An `assumption` with no note is treated the same as `none`. Otherwise the
 * escape is a one-word relabel, and the rule becomes a spelling test.
 */
export const unresolvedDimensions = (brief: WorkingBrief): DiscoveryDimension[] =>
  (brief.dimensions ?? []).filter(
    (d) =>
      d.status !== 'unavailable' &&
      (d.basis === 'none' || (d.basis === 'assumption' && !String(d.note ?? '').trim())),
  );

/** Marks that these forks caused a refusal, so the next one can escalate. */
export function recordForkRefusal(brief: WorkingBrief, ids: string[]): WorkingBrief {
  const want = new Set(ids);
  return {
    ...brief,
    questions: brief.questions.map((q) =>
      want.has(q.id) ? { ...q, blockedCount: (q.blockedCount ?? 0) + 1 } : q,
    ),
  };
}

// ------------------------------------------------- is a fork really a fork?

// ---------------------------------- what the application concluded, fed back

/**
 * The application's own verdict on a proposal, recorded so the NEXT turn can
 * see it.
 *
 * THE DEFECT THIS FIXES, measured on a live five-turn run: the application
 * told the user three times that the proposed experiment ran the same journey
 * in every arm and so could not show which customer barrier was real. The
 * agent proposed the identical design all three times. It was not ignoring the
 * finding — it never saw it. Every other thing the application establishes
 * (facts, dimensions, answered questions, limitations, sources checked) goes
 * back into the working brief. This was the one that did not, so the agent had
 * no way to correct itself inside a conversation however good the check got.
 */
export interface ApplicationVerdict {
  round: number;
  /** Whether the candidate architectures could be told apart. */
  comparison?: { status: string; why: string };
  /** Defects in the chosen design itself. */
  warnings?: string[];
  /** Why the campaign could not be generated as proposed. */
  blockers?: string[];
}

export function recordApplicationVerdict(
  brief: WorkingBrief,
  v: Omit<ApplicationVerdict, 'round'>,
): WorkingBrief {
  const warnings = (v.warnings ?? []).filter((w) => w.trim());
  const blockers = (v.blockers ?? []).filter((b) => b.trim());
  if (!v.comparison && !warnings.length && !blockers.length) return brief;
  return {
    ...brief,
    verdicts: [...(brief.verdicts ?? []), { round: brief.rounds, comparison: v.comparison, warnings, blockers }],
  };
}

/**
 * How many turns running the same warning has been raised.
 *
 * Compared on the leading sentence rather than the whole string, because the
 * warning names the experiment and the agent renames it between proposals —
 * across the measured run the same defect appeared as "Cost-reassurance vs.
 * simplicity/awareness messaging test", then "Cost-reassurance vs simplicity/
 * awareness framing", then "Cost reassurance vs simplicity framing". Matching
 * whole strings would have reported three unrelated warnings and missed that
 * nothing had changed.
 */
export function repeatedWarnings(brief: WorkingBrief): { text: string; times: number }[] {
  // Strip the names first. A warning reads: The experiment "<name>" (arms
  // <a> / <b>) runs the same journey in every arm. Everything the agent
  // controls sits inside the quotes and brackets; what identifies the DEFECT
  // is the sentence around them. Keying on the leading phrase without
  // stripping first lands inside the name, so a rename reads as a new defect
  // — which is exactly the failure this function exists to catch.
  const key = (w: string) =>
    w.replace(/"[^"]*"/g, '').replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
  const seen = new Map<string, { text: string; times: number }>();
  for (const v of brief.verdicts ?? [])
    for (const w of v.warnings ?? []) {
      const k = key(w);
      const prev = seen.get(k);
      seen.set(k, { text: w, times: (prev?.times ?? 0) + 1 });
    }
  return [...seen.values()].filter((x) => x.times > 1);
}

export type ContingencyVerdict = 'ok' | 'missing' | 'incomplete' | 'idle';

export interface ContingencyCheck {
  questionId: string;
  verdict: ContingencyVerdict;
  why: string;
}

const flat = (s: unknown) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Whether a question's claim to be a fork is supported by what it says the
 * answer would change.
 *
 * Only ever downgrades. A question with no contingency, an incomplete one, or
 * one whose two branches lead to the same decision is not treated as a fork —
 * which means it cannot block a proposal. It is still asked; it just stops
 * having the power to hold everything up on the strength of an unchecked
 * label.
 */
export function checkContingency(q: OpenQuestion): ContingencyCheck {
  const id = q.id;
  if (q.impact !== 'fork') return { questionId: id, verdict: 'ok', why: 'Not claimed as a fork.' };
  const c = q.contingency;
  if (!c)
    return { questionId: id, verdict: 'missing', why: 'Claimed to change the campaign but never said what the answer would change.' };
  const blank = (['ifA', 'thenA', 'ifB', 'thenB', 'ifUnknown'] as const).filter((k) => !String(c[k] ?? '').trim());
  if (blank.length)
    return { questionId: id, verdict: 'incomplete', why: `Contingency is missing: ${blank.join(', ')}.` };
  if (flat(c.thenA) === flat(c.thenB))
    return {
      questionId: id,
      verdict: 'idle',
      why: `Both answers lead to the same decision ("${c.thenA.slice(0, 80)}"), so the answer cannot change the campaign.`,
    };
  return { questionId: id, verdict: 'ok', why: 'Two answers, two different decisions, and a stated fallback.' };
}

/**
 * A fork the application is willing to treat as one.
 *
 * NOTE THE ASYMMETRY, and it is the whole design: a missing or incomplete
 * contingency does NOT relax the guard. Only `idle` does — the case where the
 * model has itself spelled out two answers and then said both lead to the
 * same decision.
 *
 * The first version of this required a valid contingency before a fork would
 * block, and the existing fork-guard tests immediately failed. They were
 * right to. That rule meant a model which simply omitted the new field got
 * the fork guard turned OFF, so the laziest possible response bought the most
 * freedom, and the one guard that stops the agent picking a campaign on the
 * user's behalf would have quietly stopped firing. Silence must never buy
 * permission; only an explicit, checkable claim can.
 */
const isHonouredFork = (q: OpenQuestion): boolean =>
  q.impact === 'fork' && checkContingency(q).verdict !== 'idle';

/** Every fork claim the application declined, with the reason. */
export const rejectedForks = (brief: WorkingBrief): ContingencyCheck[] =>
  unaddressedQuestions(brief)
    .filter((q) => q.impact === 'fork')
    .map(checkContingency)
    .filter((c) => c.verdict !== 'ok');

/** Unanswered non-fork questions with no stated reason for proceeding. */
export const unresolvedQuestions = (brief: WorkingBrief): OpenQuestion[] =>
  unaddressedQuestions(brief).filter(
    (q) => q.impact !== 'fork' && !(brief.questionResolutions ?? []).some((r) => r.questionId === q.id),
  );

/** Records a per-question decision to carry or defer. Unknown ids are dropped. */
export function recordQuestionResolutions(
  brief: WorkingBrief,
  resolutions: QuestionResolution[],
): WorkingBrief {
  if (!resolutions?.length) return brief;
  const known = new Set(brief.questions.map((q) => q.id));
  // Every field is required. A resolution missing its kind is not a decision
  // to carry or defer, it is a shrug — and two arrived that way in the live
  // run and were accepted, because `kind` was never checked.
  const fresh = resolutions.filter(
    (r) =>
      known.has(r.questionId?.trim()) &&
      (RESOLUTION_KINDS as readonly string[]).includes(String(r.kind ?? '').trim()) &&
      Boolean(r.why?.trim()) &&
      !(brief.questionResolutions ?? []).some((e) => e.questionId === r.questionId),
  );
  if (!fresh.length) return brief;
  return { ...brief, questionResolutions: [...(brief.questionResolutions ?? []), ...fresh] };
}

/** Marks the questions the agent says the latest reply actually answered. */
export function recordAddressedQuestions(brief: WorkingBrief, ids: string[]): WorkingBrief {
  if (!ids?.length) return brief;
  const wanted = new Set(ids.map((i) => i.trim()));
  return {
    ...brief,
    questions: brief.questions.map((q) =>
      wanted.has(q.id) && q.addressedInRound === undefined ? { ...q, addressedInRound: brief.rounds } : q,
    ),
  };
}



export const userHasRespondedOnce = (brief: WorkingBrief): boolean =>
  brief.answers.length > 0 || brief.evidenceRequests.some((e) => e.status !== 'pending');

/** Case-insensitive identity, since the name is model-supplied prose. */
const sameDimension = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * An assumption is not a finding.
 *
 * 'retained' means investigated and used in the design. A dimension closed on
 * nothing but an assumption has not been investigated — it is a decision taken
 * without evidence, which is precisely what 'deferred' already means. Observed
 * live: the agent marked "Channel sequencing and cost" and "Suppression (DNC,
 * NPA, quiet hours)" as retained/assumption, which reads in the record as
 * settled fact.
 *
 * Normalised to 'deferred' rather than reopened. Reopening would invite the
 * model to re-assert the same assumption every round, which is an endless
 * loop and not discovery — and the campaign would never be designable. The
 * rationale is preserved, and given one when the model supplied none, so a
 * deferral always says why.
 */
const ASSUMED_CLOSE = 'Closed on an assumption rather than an investigated finding.';
/**
 * Appended, not substituted, so the agent's own reason survives alongside the
 * fact that nobody checked it.
 */
const UNVERIFIED_LIMIT = 'This limitation is unverified: it rests on an assumption, not on a tool result.';

/**
 * A belief the user offered is legitimate to design on — they know their
 * customers better than any tool here does. What is NOT legitimate is the
 * record later reading as though it were established. Same treatment as
 * UNVERIFIED_LIMIT: append, never substitute, so the agent's own reasoning
 * survives next to the fact that nobody tested it.
 */
const BELIEF_NOT_FINDING =
  'This is the user\'s own explanation, carried as a hypothesis: it has not been tested and competing explanations may remain.';

const asFindingOrDeferral = (d: DiscoveryDimension): DiscoveryDimension => {
  // A belief KEEPS its status — designing on the user's read of their own
  // customers is the right thing to do, and demoting it to 'deferred' would
  // wrongly say the agent chose not to pursue it. Only the note changes, so
  // that "retained" can never be mistaken for "established".
  if (d.basis === 'user-belief') {
    return {
      ...d,
      // Idempotent, like the limitation marker: a model restating the same
      // dimension every round must not stack the sentence up.
      note: d.note?.includes(BELIEF_NOT_FINDING)
        ? d.note
        : d.note
          ? `${d.note} ${BELIEF_NOT_FINDING}`
          : BELIEF_NOT_FINDING,
    };
  }

  if (d.basis !== 'assumption') return d;

  // 'retained' claims investigated and used. An assumption is neither.
  if (d.status === 'retained') {
    return { ...d, status: 'deferred', note: d.note ?? ASSUMED_CLOSE };
  }

  // 'unavailable' claims the PLATFORM cannot do it — the mirror of the above,
  // and the more costly error: an unchecked claim of impossibility silently
  // removes a strategy that may be perfectly buildable, and would otherwise
  // be reported to the user as a confirmed platform limitation. Only a tool
  // result or the user may establish that.
  if (d.status === 'unavailable') {
    return {
      ...d,
      status: 'deferred',
      // Idempotent: a model re-asserting the same dimension must not stack
      // the marker up on every round.
      note: d.note?.includes(UNVERIFIED_LIMIT)
        ? d.note
        : d.note
          ? `${d.note} ${UNVERIFIED_LIMIT}`
          : UNVERIFIED_LIMIT,
    };
  }

  return d;
};

/**
 * Merges dimension updates into the brief, preserving everything not
 * explicitly changed.
 *
 * Three rules, and each exists because the opposite would lose a finding:
 *
 *  1. A dimension the update does not mention is left exactly as it was.
 *     Rounds arrive one at a time and a round that discusses timing must not
 *     erase what an earlier round established about the audience.
 *  2. A field the update omits keeps its previous value. A later round
 *     changing only `status` must not blank the `rationale` that justified
 *     the dimension in the first place.
 *  3. A genuinely new dimension is appended, so order reflects the order the
 *     agent raised things and is stable for rendering and for tests.
 *
 * Supplying `status` or `basis` IS an explicit change, including back to
 * 'open' — reopening a dimension is a legitimate move when a later answer
 * unsettles it.
 *
 * A fourth rule, 2026-10-21: a name that is a platform setting is not a
 * dimension. The gate wants three lines of enquiry, and live runs filled
 * those slots with "which event", "channel sequencing" and "quiet hours".
 * The prompt already says those are implementation questions. The record
 * now agrees: they are not stored, so they cannot satisfy the three.
 */
export function isPlatformDimension(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return [
    /\bentry\s+(event|point|trigger)\b/,
    /\bevent\s+type\b/,
    /\bwhich\s+events?\b/,
    /\bquiet\s+hours?\b/,
    /\bdn[cd]\b/,
    /\bdo\s+not\s+disturb\b/,
    /\btemplates?\b/,
    /\bnode\s+type\b/,
    /\bstep\s+(kind|type)s?\b/,
    /\bbuilder\b/,
    /\bchannel\s+sequenc/,
    /\bchannel\s+(order|availability|list)\b/,
    /\bwhich\s+channels?\b/,
    /\bchannels?\s+exist/,
    /\bsuppression\b/,
    /\bfailover\b/,
  ].some((re) => re.test(n));
}

/**
 * WHEN they act, as opposed to WHO acts.
 *
 * Both are real findings and only one of them can split a treatment by
 * customer. "Most conversions happen within thirty minutes" tells you when to
 * send; it does not tell you that one group behaves differently from another,
 * because every eligible customer passes through the same clock.
 *
 * MEASURED, `eval/runs/ui-s-1792738033056`. The manager gave exactly one
 * pattern in who converts — purchases above ₹10,000 — plus a timing fact and
 * a barrier. The agent proposed immediately, split the whole journey on
 * ticket size, and never asked whether anything ELSE had been seen. The
 * record then read as two retained dimensions, which looks like a search that
 * considered more than one axis. It had not: the second one was a clock.
 *
 * UNLIKE `isPlatformDimension`, THIS DOES NOT DROP ANYTHING. A timing finding
 * is worth keeping and worth designing around — it is simply not a candidate
 * for cutting the journey by customer, and not an answer to "what else have
 * you seen". Classification, not rejection.
 */
export function isTimingDimension(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return [
    /\btime\s*(-|\s)?(to|since|between|elapsed)\b/,
    /\btime\s+elapsed\b/,
    /\btiming\b/,
    /\bwhen\s+they\s+(convert|act|respond|decide)\b/,
    /\bhow\s+(soon|quickly|long)\b/,
    /\b(minutes?|hours?|days?)\s+(after|since|from|to)\b/,
    /\bdecision\s+(time|window|lag)\b/,
    /\b(request\s+)?window\b/,
    /\bexpiry\b/,
    /\bstatement\s+(date|cycle|day)\b/,
    /\bcadence\b/,
    /\bfrequency\b/,
    /\brecency\b/,
  ].some((re) => re.test(n));
}

export function recordDimensions(brief: WorkingBrief, updates: DimensionUpdate[]): WorkingBrief {
  const merged = [...briefDimensions(brief)];
  const dropped: string[] = [];

  for (const update of updates) {
    if (!update.name?.trim()) continue; // an unnamed dimension has no identity
    // Platform settings are not lines of enquiry. Drop them rather than
    // storing a slot the gate would then count — and REMEMBER the name, so
    // the brief can tell the model why its three did not land.
    if (isPlatformDimension(update.name)) {
      dropped.push(update.name.trim());
      continue;
    }
    const at = merged.findIndex((d) => sameDimension(d.name, update.name));

    if (at === -1) {
      // New. Defaults say "raised, nothing established yet" rather than
      // implying a finding the agent has not made.
      merged.push(
        asFindingOrDeferral({
          name: update.name.trim(),
          rationale: update.rationale ?? '',
          status: update.status ?? 'open',
          basis: update.basis ?? 'none',
          ...(update.note ? { note: update.note } : {}),
        }),
      );
      continue;
    }

    const prev = merged[at];
    merged[at] = asFindingOrDeferral({
      // The first spelling wins, so the identity stays stable across rounds.
      name: prev.name,
      rationale: update.rationale ?? prev.rationale,
      status: update.status ?? prev.status,
      basis: update.basis ?? prev.basis,
      ...(update.note ?? prev.note ? { note: update.note ?? prev.note } : {}),
    });
  }

  // Carried forward, so a drop on an earlier turn is still explained while the
  // count is short. Cleared implicitly: briefForPrompt stops mentioning them
  // once enough real dimensions exist.
  const carried = [...new Set([...(brief.droppedDimensions ?? []), ...dropped])];
  return { ...brief, dimensions: merged, ...(carried.length ? { droppedDimensions: carried } : {}) };
}

/**
 * The accumulated brief, rendered for the model.
 *
 * This is what stops the agent re-asking and contradicting itself: every
 * settled definition, every answer and every declined request goes back in
 * with the next prompt.
 */
export function briefForPrompt(brief: WorkingBrief): string {
  const lines: string[] = [`Objective: ${brief.objective}`, `Discovery rounds so far: ${brief.rounds}`];

  if (brief.facts.length) {
    lines.push('', 'Established (do NOT ask about these again):');
    for (const f of brief.facts) lines.push(`- [${f.source} · ${f.confidence ?? 'confirmed'}] ${f.statement}`);
  }
  const addressed = brief.questions.filter((q) => q.addressedInRound !== undefined);
  if (addressed.length) {
    lines.push('', 'Already asked and ANSWERED. Do not ask these again:');
    for (const q of addressed) lines.push(`- ${q.text}`);
  }
  // Asked, a reply came, and nothing has claimed the reply covered this one.
  const pending = unaddressedQuestions(brief);
  if (pending.length) {
    lines.push(
      '',
      'Asked, but the reply did NOT appear to answer these. Each is still open:',
    );
    for (const q of pending) {
      const r = (brief.questionResolutions ?? []).find((x) => x.questionId === q.id);
      const mark = q.impact === 'fork' ? ' [FORK]' : q.impact ? ` [${q.impact}]` : '';
      lines.push(`- [${q.id}]${mark} ${q.text}${r ? ` — you said: ${r.kind}, ${r.why}` : ''}`);
    }
    const unclassified = pending.filter((q) => !q.impact);
    if (unclassified.length) {
      lines.push(
        `${unclassified.length === 1 ? 'One of these carries' : 'Some of these carry'} no "impact" — I do not know what rides on ${unclassified.length === 1 ? 'it' : 'them'}. Say so now: "fork" if two answers mean two different campaigns, "shaping" if it changes how this one is built, "detail" if a default will do. Until you say, ${unclassified.length === 1 ? 'it is' : 'they are'} treated as unclassified and cannot be dropped.`,
      );
    }
    const forks = pending.filter(isHonouredFork);
    if (forks.length) {
      lines.push(
        `${forks.length === 1 ? 'The one marked FORK is' : 'The ones marked FORK are'} the question${forks.length === 1 ? '' : 's'} you yourself said would change the campaign, not just shape it. You may not proceed by assuming an answer: ask it, plainly and on its own, and wait. An assumption here picks one of two different campaigns on the user's behalf. If you now believe it is not actually a fork, say so explicitly and why before treating it as anything less.`,
      );
      lines.push(
        `When a FORK goes unanswered, apply its own "ifUnknown" fallback and say you did. Repeating the question is not a fallback — the first counterfactual run put the same goal question three times, and the third time said it would not choose on the user's behalf. That is a stated default's job.`,
      );
    }
    // Fork claims the application declined, with the reason.
    //
    // This is the feedback loop the `impact` field never had: the agent
    // asserted how much rode on a question and nothing could answer back. A
    // declined fork still gets asked. It simply stops being able to hold up a
    // proposal on the strength of a label nothing checked.
    const declined = pending.filter((q) => q.impact === 'fork').map(checkContingency).filter((c) => c.verdict !== 'ok');
    if (declined.length) {
      lines.push(
        `You marked ${declined.length === 1 ? 'this question' : 'these questions'} FORK, but I am not treating ${declined.length === 1 ? 'it' : 'them'} as one, because a fork has to say what the answer would change:`,
      );
      for (const d of declined) lines.push(`- [${d.questionId}] ${d.why}`);
      lines.push(
        'Give each a "contingency" — if they say A you do one thing, if they say B you do another, and if they cannot answer you apply a stated default. If you cannot name two answers that lead to two different decisions, then the answer does not change the campaign and the question is not worth the user\'s attention. Drop it or ask a better one.',
      );
    }
    lines.push(
      'For every other one, do one of two things and say which, naming the question id in "questionResolutions": carry it (it stays a live uncertainty the strategy works around) or defer it (a stated default applies). A reason attached to no question resolves no question. Silently dropping one is not an option, and recording it as a settled finding when nobody answered it is worse.',
    );
  }
  // The true interaction history, stated as fact.
  //
  // Measured on both verification scenarios: having asked ONE round of three
  // questions, the agent justified proposing with "Asked twice (round 1 and
  // implicitly in round 2)" and "rather than asking a third time". Neither
  // happened. A stopping rule based on judgement rather than a count is only
  // as good as the agent's view of what it has already done, and it was
  // inventing a history in which it had tried harder than it had.
  const neverReplied = brief.questions.filter((q) => q.answeredInRound === undefined);
  lines.push(
    '',
    `Your actual question history: ${brief.questions.length} question(s) asked across ${brief.rounds} round(s), ${addressed.length} answered, ${pending.length} asked but not answered, ${neverReplied.length} awaiting any reply. These are the real counts — do not claim to have asked something more often than this says, and do not treat a question the user simply did not address as one they refused.`,
  );
  lines.push(
    'When you reply, list in "answered" the id of every question above that the user\'s latest message genuinely addressed. Claim only the ones they really answered: an unanswered question you mark as answered disappears from this record, and you will design around a gap nobody told you about.',
  );
  if (brief.answers.length) {
    lines.push('', "The user's answers, in order:");
    brief.answers.forEach((a, i) => lines.push(`${i + 1}. ${a.text}`));
  }
  if (brief.evidenceRequests.length) {
    lines.push('', 'Data already requested:');
    for (const e of brief.evidenceRequests) {
      lines.push(
        `- ${e.question} [${e.status}]${e.status === 'unavailable' ? ' — do NOT ask for this again; treat it as a stated limitation' : ''}`,
      );
    }
  }
  const conflicts = (brief.statedValues ?? []).filter((s) => s.status === 'value-not-allowed');
  if (conflicts.length) {
    lines.push('', 'UNRESOLVED CONFLICTS between what the user said and what the platform defines:');
    for (const c of conflicts) {
      lines.push(`- ${c.explanation} Do NOT substitute a different attribute or value for this. Ask which of the real values they mean, or say plainly that the concept cannot be expressed.`);
    }
  }
  const matched = (brief.statedValues ?? []).filter((s) => s.status === 'matches');
  if (matched.length) {
    lines.push('', 'Values the user gave that the platform accepts:');
    for (const m of matched) lines.push(`- ${m.attribute} = ${m.canonical ?? m.value}`);
  }
  if (brief.limitations.length) {
    lines.push('', 'Limitations to carry into the strategy:');
    for (const l of brief.limitations) lines.push(`- ${l}`);
  }

  // The record the agent itself built, sent back so it can UPDATE rather than
  // restate. Measured: without this, the same five dimensions came back
  // reworded on the next turn ("7-day request expiry window" became "Window
  // before the request closes"), and the record doubled every round — one
  // question ended up held twice with contradictory provenance. Matching is by
  // exact name, so the names have to be visible to be reused.
  const dims = brief.dimensions ?? [];
  if (dims.length) {
    lines.push('', 'Dimensions you have already recorded. Reuse the NAME EXACTLY to update one; a new name creates a new entry:');
    for (const d of dims) {
      lines.push(`- "${d.name}" [${d.status}/${d.basis}]${d.note ? ` — ${d.note}` : ''}`);
    }
  }

  // The stopping decision, computed by the application and put in front of the
  // model rather than left implicit.
  //
  // Measured across five live runs: the agent asked three good questions, took
  // the answers, closed every dimension on that same turn and proposed. It was
  // never WRONG to stop — it simply never considered the question, because
  // nothing in the brief asked it to. Listing the beliefs it is about to build
  // on, by name, turns an omission into a decision it has to make out loud.
  const beliefs = dims.filter((d) => d.basis === 'user-belief');
  if (beliefs.length) {
    lines.push(
      '',
      'DECIDE BEFORE YOU PROPOSE. You are about to design on these explanations, which the user offered as their own reading and which nothing has tested:',
    );
    for (const b of beliefs) lines.push(`- "${b.name}"`);
    lines.push(
      'For each, take ONE of two exits and say which in your answer: ask a question that separates the competing explanations, or carry them into the strategy as hypotheses. Asking is right when they are likely to know and the answer would change the design. Carrying is right when they genuinely cannot know, or when every explanation leads to the same campaign — say so plainly. Designing for one reading without saying you chose it is not an option.',
    );
  }
  // WHAT WAS DROPPED, AND WHAT TO RAISE INSTEAD.
  //
  // `recordDimensions` refuses to store a dimension that names a platform
  // setting. Doing that silently is how the agent got stuck: it raised three,
  // none landed, the gate said "raise at least 3", and with no way to know
  // what had happened it raised the same three again.
  //
  // Only shown while the count is actually short. Once three real dimensions
  // exist the sentence stops on its own, so a drop from an early turn does not
  // nag for the rest of the conversation.
  const dropped = brief.droppedDimensions ?? [];
  if (dropped.length && briefDimensions(brief).length < MIN_DIMENSIONS_CONSIDERED) {
    lines.push(
      '',
      `These were not stored as lines of enquiry because they describe the platform, not the customer: ${dropped.join(', ')}.`,
      'Raise three things about the customers — who they are, what state they are in, whether they have already started.',
      'Do not raise entry events, channel lists, templates, quiet hours, or DND.',
    );
  }

  // A dimension the gate is holding the proposal on, with the ONE thing that
  // clears it named explicitly.
  //
  // MEASURED DEADLOCK. `unresolvedDimensions` refuses a proposal while a
  // dimension sits on `basis: 'assumption'` with no `note`. Nothing told the
  // model that a note was what the application wanted, so it did the only
  // other thing the refusal suggested — asked another question — and the same
  // refusal regenerated verbatim on the next turn. Observed three times in a
  // row in one session, with the user answering every time.
  const stuck = unresolvedDimensions(brief);
  if (stuck.length) {
    lines.push(
      '',
      'THESE ARE HOLDING UP YOUR PROPOSAL, and a question will not clear them:',
    );
    for (const d of stuck) lines.push(`- "${d.name}"`);
    lines.push(
      'Each is recorded as your own assumption with no reason attached. Send it again in "dimensions" with a "note" saying what you concluded and why — including "the user does not know, so I am assuming X", which is a complete reason. A note is what releases it. Asking another question does not.',
    );
  }
  const sc = brief.successCriteria ?? [];
  if (sc.length) {
    lines.push('', 'How success is to be judged, already settled:');
    for (const c of sc) lines.push(`- ${c}`);
  } else if (brief.answers.length) {
    // The user HAS answered something. Saying "ask the user" here told the
    // agent to re-ask a question it had just been answered, on the very turn
    // it was supposed to propose — measured on the OS-to-EMI strategy turn,
    // where the brief read NOT YET SETTLED while the answer sat in
    // `answers` and in the message history. `successCriteria` lags by one
    // turn because it is only populated from the model's own propose
    // payload, so the brief must say "record it", not "ask again".
    lines.push(
      '',
      'How success is to be judged: NOT YET RECORDED. If the answers above settle it, record it in "successCriteria" on this turn. Do not ask again for something they have already told you.',
    );
  } else {
    // Nothing settled and nothing answered yet: this is the first round.
    //
    // MEASURED, and the reason this branch says more than "ask the user": on
    // the OS-to-EMI run the agent asked whether success meant the NUMBER of
    // conversions or the VALUE converted — a good question — as the second of
    // three questions, alongside questions about the audience and the
    // suspected barrier. The user answered that value mattered more, and that
    // single answer decided which audience dimension was worth investigating
    // at all. Asked in the same breath as the audience questions, it arrived
    // too late to direct them, and they were generic as a result.
    //
    // So the sequence is not cosmetic. The objective's answer changes which
    // other questions are worth asking, which means it has to come first.
    lines.push(
      '',
      'How success is to be judged: NOT YET SETTLED, and nothing has been answered yet.',
      'THIS ROUND IS FOR THE OBJECTIVE AND NOTHING ELSE. Every question you ask now must be about what the business is trying to achieve and how it would judge the result. Not the audience, not the suspected cause, not what data exists — those come after.',
      'The answer to this changes which of those are worth asking at all, so asking them in the same breath wastes them. Settle what success means, then let the answer tell you what to investigate.',
    );
  }
  // What the application said about your last proposal.
  //
  // Placed immediately before the retrieval record and after the objective, so
  // it is the last substantive thing read before designing again.
  const last = (brief.verdicts ?? [])[(brief.verdicts ?? []).length - 1];
  if (last) {
    lines.push('', 'WHAT THE APPLICATION FOUND IN YOUR LAST PROPOSAL. This is not a style note. It was shown to the user underneath your strategy, so they have already read it:');
    if (last.comparison && last.comparison.status !== 'differentiated')
      lines.push(`- The alternatives you offered were judged ${last.comparison.status}: ${last.comparison.why}`);
    for (const w of last.warnings ?? []) lines.push(`- ${w}`);
    if (last.blockers?.length)
      lines.push(`- The campaign could not be generated: ${last.blockers.slice(0, 3).join(' ')}`);

    const repeats = repeatedWarnings(brief);
    if (repeats.length) {
      lines.push(
        `You have now been told this on ${repeats[0].times} separate proposals and proposed the same design each time. Rewording the name of an experiment does not answer it. Either change what the arms actually DO so they differ in something a customer experiences — a different moment, a different audience, a different journey — or drop the claim that this campaign can establish the cause, and say plainly that it compares wording only.`,
      );
    } else {
      lines.push(
        'Fix it or say why you are keeping it. Repeating the same design unchanged is not an answer.',
      );
    }
  }

  // THE TWO CUSTOMER FINDINGS, and what is still missing from them.
  //
  // Rendered here rather than in the system prompt deliberately. The prompt is
  // at its length limit, and more importantly this only matters when it
  // applies: an agent that already knows who converts should not be reading a
  // paragraph about what to do when nobody knows. State the gap, in the round
  // where it is the gap.
  const conv = brief.converters;
  if (!conv) {
    lines.push(
      '',
      'WHO CONVERTS TODAY: not established. Ask. Without it there is no way to say who this campaign is for.',
    );
  } else if (conv.knowledge === 'known') {
    lines.push('', `Who converts today: ${conv.shape} [${conv.basis}]`);
  } else {
    const label = conv.knowledge === 'none-yet' ? 'nobody has converted yet' : 'nobody can say who converts';
    const cands = conv.candidates ?? [];
    lines.push('', `Who converts today: ${label}. This campaign therefore has to FIND OUT.`);
    // TRENDS TO TEST, NOT GROUPS TO TARGET.
    //
    // This block used to end "Then ask which they would back. Do not pick a
    // target and proceed as though they had agreed to it." — which is a menu
    // of groups put to the manager, and the entry is not theirs to pick: it
    // is every eligible customer who has not done the behaviour, always. A
    // candidate is a guess about who is LIKELIER, and the honest thing to do
    // with a guess is cut the treatment by it and read the result, not shrink
    // the audience to it.
    //
    // The "wait for their reaction" line went with it, for the reason
    // `convertersSettled` already records: asking them to back one of the
    // agent's own guesses is a decision neither of them can make yet.
    if (cands.length < 2) {
      lines.push(
        `You have put forward ${cands.length} usable trend(s). Put forward at least TWO, as candidate trends to TEST — never as a choice of who to target, and never as a reason to narrow the entry. CHECK THEM YOURSELF BEFORE YOU PUT THEM UP: it is not their job to notice that two of your options are the same thing under different names. Each needs "restsOn", the attribute or behaviour that defines it, derived from THIS objective rather than borrowed from another one; two resting on the same thing are not a choice and are rejected. Each needs "why": the mechanism that would make that group likelier, not the label again. "They spend a lot, because they spend a lot" says nothing. Then ask whether they have SEEN any of this in their own book, or do not track it — both answers are fine, and neither changes who enters.`,
      );
    } else {
      for (const c of cands) lines.push(`- candidate trend: ${c.segment} [rests on: ${c.restsOn}] — ${c.why}`);
      lines.push(
        'Everyone eligible still enters. Cut the TREATMENT by these — cadence, channel, wording, an extra touch on one path — or test them against each other, so the run tells you which holds. The remainder keeps a path. Do not use them to decide who gets in, and do not wait for the manager to pick one.',
      );
    }
  }

  const bars = brief.barriers ?? [];
  if (!bars.length) {
    // The SHAPE, at the point of failure, not only in the big schema.
    //
    // MEASURED: with both fields added to the OUTPUT schema, the agent began
    // sending "converters" immediately and never once sent "barriers" — while
    // discussing the barrier correctly in prose, naming two competing
    // causes and saying it would test between them. It reasoned about the
    // thing and structured it nowhere. `converters` sits first in that block
    // and `barriers` last, which is the kind of detail a long JSON example
    // loses. Saying it here, in the round where it is missing, costs no
    // system-prompt budget and arrives attached to the gap it fixes.
    lines.push(
      'WHY THE REST DO NOT: not established, and discussing it in your reply does NOT record it. Send it as a field:',
      '  "barriers":[{"id":"cost","statement":"They think converting is expensive.","basis":"user-belief","lever":"message","quote":"<their actual words>"}]',
      'A guess they offered IS a barrier — that is what basis "user-belief" is for. Two competing causes are two entries, not a reason to send none. A campaign that addresses no stated reason is just more contact.',
    );
  } else {
    lines.push('Why customers are not converting:');
    for (const b of bars) {
      const usable = b.basis === 'user' || b.basis === 'user-belief';
      lines.push(
        `- ${b.id}: ${b.statement} [${b.basis}${b.lever === 'not-addressable' ? ', nothing can fix this' : `, attack with ${b.lever}`}]` +
          (usable ? '' : ' — NOT usable: this traces to nothing they said, so no campaign may rest on it. Ask them, or drop it.'),
      );
    }
  }

  const checked = brief.contextChecked ?? [];
  if (checked.length) {
    lines.push('', 'Sources already checked:');
    for (const c of checked) lines.push(`- ${c.source} — ${c.found ? 'something relevant found' : 'nothing relevant found'}`);
  }
  return lines.join('\n');
}
