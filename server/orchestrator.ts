// The one campaign orchestrator.
//
// It owns the whole workflow: context retrieval, the LLM calls for discovery /
// strategy / refinement, stage transitions, campaign construction through the
// application's own reducer, deterministic validation, and the run-event log.
//
// The split of responsibility is deliberate and enforced here:
//   LLM  -> business reasoning (objective, questions, strategy, refinements)
//   code -> limits, authoritative vocabulary, graph construction, validation,
//           export eligibility, state, events
// The model cannot override a deterministic rule: everything it proposes goes
// through buildFromBlueprint, which rejects anything outside the real
// vocabulary, and then through the app's own validators.
import {
  extractJson,
  resolveModel,
  streamClaude,
  AnthropicConfigError,
  type ApiMessage,
} from './anthropic';
import { runTool, toolTitle, toolsForPhase } from './agentTools';
import { EventEmitterSeq, type RunEvent } from './runEvents';
import { auditOptions, applyAudit, unsupportedClaims, copyOnlyExperiments, type OptionAudit } from './optionAudit';
import { compareArchitectures, checkFidelity, checkExperimentClaims, checkAudienceLearning, checkBarrierCoverage, checkBarrierTesting, JOURNEY_BEHAVIOURS } from './architectureAudit';
import { jargonNotes } from './plainLanguage';
import { journeySummary, readableBlocker } from './journeySummary';
import { mustBeAddressed, mustLearnAudience, mustTestBarriers, type Barrier, type Converters } from './findings';
import {
  evaluate as evaluateCapability,
  briefBack as briefBackCapability,
  gaps as capabilityGaps,
  type Requirement as CapabilityRequirement,
  type RequirementVerdict,
} from './capability';
import {
  evaluateDiscovery,
  recordAddressedQuestions,
  recordUncoveredQuestions,
  recordQuestionResolutions,
  unansweredForks,
  recordForkRefusal,
  unresolvedDimensions,
  unresolvedQuestions,
  asImpact,
  asContingency,
  recordApplicationVerdict,
  type QuestionResolution,
  type QuestionImpact,
  fingerprint,
  newBrief,
  recordAnswer,
  recordQuestions,
  recordEvidenceRequests,
  resolveEvidence,
  noteVolunteeredLimitation,
  briefForPrompt,
  objectiveChangedMaterially,
  recordDimensions,
  recordSuccessCriteria,
  recordBarriers,
  recordConverters,
  MAX_FORK_REFUSALS,
  type QuestionContingency,
  recordContextChecked,
  outstandingDimensions,
  briefDimensions,
  type DimensionUpdate,
  type EvidenceRequest,
  type OpenItem,
  type WorkingBrief,
} from './discovery';
import { detectStatedValues, mergeStatedValues, unresolvedConflicts } from './conflicts';
import { eventConditionTarget } from '../src/data/conditionValidation';
import {
  mayGenerate,
  newSession,
  transition,
  invalidateConfirmation,
  type CampaignState,
  type SessionState,
} from './campaignState';
import { DC_NODE_META } from '../src/data/nodeMeta';
import { dcAddFormValid } from '../src/reducer/defaultConfig';
import { loadCapabilities, knowledgeForPrompt, type KnowledgeBase } from './knowledge';
import { buildFromBlueprint, blueprintVocabulary, issuerContext, type CampaignBlueprint, type BuildIssue, type SendProposal } from './blueprint';
import { validateCampaignGraph, type ValidationReport } from '../agent-proto/validate';
import { buildCampaignProposal, type CampaignFieldProvenance } from '../agent-proto/campaignFields';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTenant, type TenantConfig } from './tenants';
import type { Channel } from '../src/data/sharedConstants';
import type { DripCampaign, DripGraph } from '../src/data/graphTypes';

const here = dirname(fileURLToPath(import.meta.url));
const bankContext = () => JSON.parse(readFileSync(resolve(here, '../agent-proto/context/bank-context.json'), 'utf8'));

export const MAX_DISCOVERY_ROUNDS = 8;
export const MAX_QUESTIONS_PER_ROUND = 3;

/**
 * Explicit conversation phases. The server decides the phase; the client
 * renders it. Nothing is inferred from "does a graph exist" — that inference
 * is what let generation run before the strategy was agreed.
 */
export type Phase =
  | 'understanding'
  | 'discovery'
  | 'awaiting-confirmation'
  | 'generating'
  | 'review'
  | 'error';

/** Kept for the existing run-record shape. */
export type Stage = 'discovery' | 'proposed' | 'blocked' | 'error';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface Strategy {
  summary: string;
  approach: string[];
  rejected?: { option: string; why: string }[];
  assumptions: string[];
  unknowns: string[];
  evidenceNotes?: string[];
  /**
   * How the business would judge this campaign, in its own terms. NOT the goal
   * event — the goal proves the behaviour happened, this says what counts as
   * the campaign having worked.
   */
  successCriteria?: string[];
  /**
   * What to track, how to evaluate it, and what would be needed to measure it.
   * Qualitative and actionable only. No target, no historical figure and no
   * forecast: no performance history exists for this bank, so a number here
   * would be invented.
   */
  measurement?: string[];
  /** Worth testing later, explicitly not claimed now. */
  hypotheses?: string[];
  /**
   * The verdict on each strategic option weighed before the journey was
   * settled: segmentation, experimentation, branching, fallback, adaptive
   * sequencing, cost/fatigue, measurement.
   *
   * A record rather than prose in `approach` because the thing worth showing
   * is the NEGATIVE case. An option the agent never thought about and one it
   * weighed and set aside both read as silence in a strategy, and the reader
   * cannot tell which happened — which is exactly how a journey ends up a
   * linear chain of sends by default rather than by decision.
   */
  strategyOptions?: { option: string; verdict: 'used' | 'not-applicable' | 'cannot-evaluate'; why: string }[];
  /**
   * The candidate campaign architectures weighed before one was chosen, and
   * why the winner won. RULE 2.1.
   *
   * An architecture is the entry and audience, the mechanism of persuasion and
   * the triggering logic — the decisions that determine WHO is reached, WHEN,
   * and BY WHAT MEANS. Message count, tone and channel order are not
   * architecture; varying them produces the same campaign.
   *
   * MEASURED: across both scenarios the only alternative ever weighed was
   * "send one message instead of three" — a degenerate version of the same
   * plan, dismissed in a sentence. In the OS-to-EMI run a real alternative
   * existed and was never compared: entering on Account audience by Statement
   * Due Date (timing-precise, eligibility-blind) against the Transaction event
   * on EMI Eligible (eligibility-precise, timing-blind). The agent picked one
   * and reported the other's advantage as a platform limitation.
   */
  architectures?: {
    name: string;
    /** Entry event or audience, in business terms. ALSO the audience implication. */
    entry: string;
    /** What behaviour it tries to change, and by what means. Prose, for a human. */
    mechanism: string;
    /** When it fires and what paces it. ALSO the timing implication. */
    timing: string;
    /** What it gives up relative to the other candidate. */
    tradeoff: string;
    chosen: boolean;
    /** On the winner: why, citing the discovery record. */
    whyChosen?: string;

    // ---- the mechanism, decomposed so the application can check it ----
    //
    // `mechanism` above is prose and will stay prose: no string comparison can
    // establish that "reduce perceived cost" and "improve cost comprehension"
    // are the same intervention or different ones. Asking code to judge that
    // would be theatre.
    //
    // What code CAN check is whether two candidates have different
    // CONSEQUENCES. Two campaigns whose audience, timing, journey behaviour
    // and measurement are all the same are the same campaign, whatever their
    // mechanisms are called. So the four fields below — with `entry` and
    // `timing` already serving as the audience and timing implications, not
    // duplicated here — are the tuple `architectureAudit` compares.
    //
    // MEASURED, and the reason this exists: in the growth-config run the agent
    // ran an experiment whose two arms were labelled cost-hesitation and
    // friction-hesitation and were the identical journey with different copy.
    // It reported that as testing two competing explanations.

    /** The customer problem or behaviour this candidate addresses. */
    barrier?: string;
    /** The intervention itself — what is actually done about the barrier. */
    lever?: string;
    /** What the journey DOES differently as a result: branching, pacing, exits. */
    journey?: string;
    /** How this candidate would be judged, and what would show it worked. */
    measurement?: string;
  }[];
  /**
   * Set by the application, never by the model: whether the candidates it
   * offered are actually distinguishable. See `server/architectureAudit.ts`.
   */
  architectureComparison?: {
    status: 'differentiated' | 'insufficient' | 'incomplete';
    why: string;
  };
  /**
   * Things wrong with the chosen design itself, as opposed to the comparison
   * between candidates. Kept separate because conflating them produced a
   * self-contradictory verdict: candidates that genuinely differed were
   * announced as "not materially different" because the experiment inside the
   * winner happened to vary only copy. Different questions, different answers.
   */
  designWarnings?: string[];
}

export interface OrchestratorRequest {
  sessionId: string;
  /** Full conversation so far. The newest user turn is the active input. */
  messages: ChatTurn[];
  knowledge: KnowledgeBase;
  /** Rounds of discovery already completed in this session. */
  discoveryRounds: number;
  /** Present when refining an existing campaign. */
  currentCampaign?: DripCampaign | null;
  /**
   * Only an ID crosses the wire. The tenant's configuration is resolved
   * server-side so a browser cannot supply another tenant's settings.
   */
  tenantId?: string;
  /** Real account/template ids a person has supplied, keyed by step name. */
  resolvedSends?: Record<string, { account?: string; templateId?: string }>;
  /** Force a proposal even if the model would rather keep asking. */
  forceProposal?: boolean;
  /**
   * What the user is asking for on THIS turn.
   *  - 'converse'  : answer a question, give the brief, or request a change.
   *  - 'confirm'   : build the campaign from the strategy already proposed.
   * A graph is only ever constructed for 'confirm', or for a refinement of a
   * campaign that already exists.
   */
  intent?: 'converse' | 'confirm';
  /** The blueprint the user is confirming. Echoed back from the proposal. */
  confirmedBlueprint?: CampaignBlueprint | null;
  /** The strategy that accompanied it, for the record. */
  confirmedStrategy?: Strategy | null;
  /**
   * The accumulated brief and state machine, round-tripped by the client.
   * The server owns the logic; the client just carries it between turns.
   */
  brief?: WorkingBrief | null;
  session?: SessionState | null;
}

export interface OrchestratorResponse {
  sessionId: string;
  runId: string;
  phase: Phase;
  stage: Stage;
  /** What to show in chat. */
  reply: string;
  questions: string[];
  strategy: Strategy | null;
  blueprint: CampaignBlueprint | null;
  campaign: DripCampaign | null;
  graph: DripGraph | null;
  provenance: CampaignFieldProvenance | null;
  unresolvedCampaignFields: string[];
  campaignBlockers: string[];
  validation: ValidationReport | null;
  buildIssues: BuildIssue[];
  templateChoices: { step: string; templateId: string | null; channel: string; reason: string }[];
  /** Communication steps still needing a real account and template id. */
  sendProposals: SendProposal[];
  discoveryRounds: number;
  discoveryLimitReached: boolean;
  exportable: boolean;
  exportBlockedReason?: string;
  events: RunEvent[];
  /** The blueprint awaiting confirmation. Null once built or still in discovery. */
  pendingBlueprint: CampaignBlueprint | null;
  /** A journey was constructed and carries no build issues. */
  designGenerated: boolean;
  /**
   * Import readiness is never asserted. No import contract exists in this
   * repository to verify one against, so the status is 'unverified' and
   * `outstanding` lists what a person must still prepare by hand.
   */
  importReadiness: {
    status: 'unverified';
    reason: string;
    outstanding: string[];
  } | null;
  /** The application's own state, returned so the client carries it forward. */
  brief: WorkingBrief | null;
  session: SessionState | null;
  /** Why the application decided to ask rather than propose, when it did. */
  discoveryReason?: string;
  /** Data the agent has asked for this round. Empty unless requesting evidence. */
  evidenceRequests: Omit<EvidenceRequest, 'id' | 'askedInRound' | 'status'>[];
  /**
   * Whether the PROPOSED blueprint could be built, decided before anything is
   * constructed. Confirming a strategy says the approach is right; it says
   * nothing about whether the configuration is valid, and the two were
   * previously indistinguishable to anyone reading the response.
   */
  graphReadiness: { status: 'ready' | 'blocked'; blockers: string[]; limitations: string[] } | null;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * The system prompt for THIS turn.
 *
 * THE LEAK THIS CLOSES, and it was the largest one. `SYSTEM` is sent on every
 * turn, and it contains the complete blueprint grammar: the entry and goal
 * shapes, every step kind, the real entity names (Customer, Account,
 * Transaction), real attribute names (Status, Transaction Amount), the
 * `existence:'none'` lookback and entity `groups`. So the context block
 * telling the agent "you do not have the builder's vocabulary, OMIT
 * blueprint" arrived immediately after handing it that vocabulary in full —
 * a superset of what `blueprintVocabulary` was being withheld.
 *
 * Removing `blueprintVocabulary` from the context while this stayed made the
 * phase separation mostly theatre, which an audit caught and I had already
 * claimed was fixed.
 *
 * The grammar is cut out on any turn that is not building. `SYSTEM` itself is
 * left whole: a dozen tests read it from source to pin exact phrasing, and
 * the honest thing to vary is what gets SENT, not what the file says.
 */
export function systemForPhase(isBuildTurn: boolean): string {
  if (isBuildTurn) return SYSTEM;
  const from = SYSTEM.indexOf('"blueprint":{');
  const entryLine = SYSTEM.indexOf('Entry may instead be');
  if (from < 0 || entryLine < 0) return SYSTEM;
  const to = SYSTEM.indexOf('\n', entryLine);
  return (
    SYSTEM.slice(0, from) +
    '"blueprint": OMITTED THIS TURN. Nothing is being built, so the builder\'s grammar is not yours to work in yet. Describe the journey in "strategy.approach" instead, in the campaign manager\'s terms.\n}\n' +
    SYSTEM.slice(to)
  );
}

const SYSTEM = `You are a campaign strategist for a bank card-programme marketing platform. You design drip campaigns: multi-step customer journeys made of messages, waits, branches and exits.

You do the business reasoning. Deterministic application code builds the graph, validates it and owns every id, so you never emit node ids, edge ids, field names or template ids.

YOU ARE WRITING TO A CAMPAIGN MANAGER AT THE BANK. They know their business and have never seen this system's internals. Write plain, complete sentences. Never show them an internal identifier: a question id, a principle code, a raw underscored event or enum name, or a path into the data. Name things in words, which is plainer AND more exact. Never narrate your own bookkeeping: "both fork questions are now answered", "per this round's scope", "(retained)" are this system talking to itself, and a fork is OUR word, not theirs. Lead with what you now understand about THEIR business in the words they used. Report like a colleague: what you learned, what it changes, what you still need.

GROUND RULES
- Use only the events, entities, attributes, values, channels and step kinds the tools report. Anything else is rejected by the builder, so check before you commit to an entry trigger, a goal event, an attribute value or a channel — and never ask the user to confirm something a tool can tell you.
- Never claim a conversion lift, a cost saving or a performance number. No performance data exists for this bank. An expected effect is an untested hypothesis and must be labelled as one.
- A drop-off does not prove its cause. Do not assert causes you cannot evidence.
- Treat knowledge marked [status: invented] as unverified mock data.
- Respect the hard constraints in the knowledge base (minimum spacing, quiet hours, channel availability). Preferences are tradeable; say when you trade one off.

HOW TO DESIGN A CAMPAIGN

Work through this. Go deeper where the objective needs it, skip what it does not, and say which parts you skipped and why. For each real decision, state the decision, what you relied on, and the trade-off you accepted.

1. The outcome and the behaviour.
   What business outcome is wanted, and what must the customer DO differently? Name the behaviour as an action, not a metric. Separate the user's business objective from the platform's formal goal: the goal is the event that proves the behaviour happened. If no event can prove it, say so — that is a limitation, not something to invent around.
   Then settle HOW SUCCESS WOULD BE JUDGED, and record it in "successCriteria". This is the business's own measure, not the goal event, and it is THEIRS to give. On your FIRST turn you must ASK for it — do not write yourself a "working definition" and carry on, which silently decides what the campaign optimises for. Only once they have answered, or said they have no target, may you record a working measure and say whose it is.
   THE METRIC THEY NAME MAY NOT BE THE VALUE THEY WANT. A count and a value pull in opposite directions: maximising the NUMBER of conversions favours whoever converts most easily, which is usually the smallest and least valuable cases. Ask yourself what the business actually gains when this number moves, and if the two could diverge, say so and ask which they mean. This is one question, asked once, and it changes who you target and how success is read.
   "measurement" is what to TRACK and how to EVALUATE it, plus what would be needed to measure it properly. Keep it qualitative and actionable. Never state a target, a historical result or a forecast of lift: no performance history exists for this bank, so any number here would be invented.

FIRST, FIND OUT WHO CONVERTS AND WHY THE REST DO NOT, and send "converters" and "barriers" on EVERY turn — shapes are in OUTPUT. You cannot propose without both. ASK. Never offer a list of likely reasons, and never supply your own. Every barrier needs a "quote" of their actual words: the application checks it against what they typed and marks an invented one an assumption, which no campaign may rest on. "They have no idea" is an answer; deciding it yourself is not. When nobody knows who converts, give TWO candidate segments resting on different things and wait for their reaction.

2. The dimensions. Do this BEFORE you pick an entry event or design anything.
   Name the 3-5 things about THIS objective whose answers could genuinely change the campaign, and record each one in "dimensions". Derive them from the objective in front of you and from what the data can actually distinguish — never from a standard list of generic marketing dimensions. Customers differ from each other in ways that may matter: who they are, what state their account is in, what is blocking the behaviour, what amounts or balances are involved, when the opportunity appears. Say which of those matter here and which do not.
   A DIMENSION IS A BUSINESS OR CUSTOMER FACTOR, never a platform setting. Balance or transaction size, who these customers are, their credit utilisation and financial behaviour, how urgent the moment is: those are dimensions. A REASON CUSTOMERS DO NOT ACT IS NOT A DIMENSION — it belongs in "barriers", and recording it here instead leaves "barriers" empty, which blocks the campaign no matter how complete this list looks. "They have not been nudged enough", "they think it costs too much", "they do not know the option exists": all barriers, none of them dimensions. A dimension is a factor that might SEGMENT these customers; a barrier is what is stopping them. Which event to enter on, which channels exist, which attribute the builder exposes, whether an event is confirmed live — those are IMPLEMENTATION questions. They matter, and they belong to the platform mapping you do after the business strategy is settled. They must not occupy the 3-5 slots, and an answer about them is not discovery.
   THE USER IS THE PRIMARY SOURCE for a dimension. Most of these cannot be looked up: only they know what they have seen in their own customers, what they believe is driving the behaviour, and which difference they think matters. Ask them.
   BUT DO NOT ONLY RECORD WHAT THEY RAISED. Proposing a factor they did not name is your job, not theirs: a user who could already name every factor that mattered would not need you. Read the real attribute list and ask which customer differences could plausibly predict this outcome — amount or balance bands, credit limit, utilisation, tenure, status, recency, the issuer's own tags. Name the two or three most likely and say why each could matter here.
   UNCERTAINTY WIDENS THE SEARCH, IT DOES NOT NARROW IT. When the user says they are not sure what the barrier is, that is the moment to put MORE candidate factors on the table, not to accept their hunch and move on. Another factor may correlate far more strongly than the one they guessed.
   A FACTOR YOU WILL NOT OPTIMISE FOR MAY STILL PREDICT THE OUTCOME. "They told me success is counted, not valued" is a reason not to PRIORITISE large balances. It is not a reason to ignore balance size, because large and small balances may convert at completely different rates. Only set a factor aside when it cannot be expressed at all, or when you have said plainly why it could not change who should get what.
   This is not licence to fill the slots with platform concerns. "Which event do I enter on", "which channels exist", "is this event confirmed live" remain implementation questions and are still barred from the 3-5 slots. The test is whether the answer describes a CUSTOMER, not a configuration.
   - Could the answer change the campaign? If not, do not raise it.
   - Does the user already know, believe or suspect something about it? Then ASK — set status "open" and put the question to them. A hypothesis of theirs is worth more than a guess of yours.
   - Have you already been told, or does the retrieved context already say? Then do not ask again; record it with basis "user" or "tool".
   NEVER close a dimension because the platform cannot express it. Ask the user whether it matters first, record what they say, and carry the unbuildability as a limitation for the mapping stage. A business factor that turns out to be unbuildable is still a finding the user needs; silently dropping it is the one outcome that is never acceptable, and do not substitute a loosely related attribute for the one that is missing or imply the targeting is possible. Missing numbers are likewise not a reason to drop a dimension — a strategically important factor with no data behind it stays in the record as a hypothesis.
   status is one of "open" (still investigating), "retained" (resolved and used), "deferred" (you chose not to pursue it, and the note says why) or "unavailable" (the platform cannot act on it — use this only AFTER the user has given their view, and keep that view in the note). basis is what the status rests on: "tool", "user", "user-belief", "assumption" or "none" — never claim "tool" or "user" for something you assumed. "user" is for what they OWN and are the authority on: their definition, their target, their decision. "user-belief" is for their explanation of WHY customers behave as they do — a conjecture about cause, which they cannot actually know and which competing explanations may contradict. Record a stated cause as "user-belief" every time, however confidently it was put to you; calling it "user" turns their guess into the finding your campaign rests on. Never invent a threshold, a bucket, a distribution or a rate to close one out.
   WEIGH EVERY QUESTION BEFORE YOU ASK IT, AND SAY HOW MUCH RIDES ON IT. Give each one an "impact": "fork" if two different answers mean two different campaigns — a different goal, a different audience, a different entry moment, a different core intervention; "shaping" if it changes how the campaign is built rather than what it is; "detail" if a sensible default exists and stating it costs nothing. Decide this when you ASK, not later: by the time you want to design, an awkward question is tempting to call a detail.
   A FORK YOU HAVE NOT HAD ANSWERED STOPS YOU. You may not infer it from something else they said, and you may not write it down as an assumption and carry on — both of those choose one of two campaigns for them. Ask it on its own, plainly, and wait. The cost of one short question is a turn; the cost of guessing is a campaign aimed at the wrong people. Anything that is not a fork may be carried (a live uncertainty the design works around) or deferred (a default you state), each naming its question id in "questionResolutions" with the reason. A reason attached to no question resolves no question.
   READ THEIR REPLY AS AN ANSWER FIRST. Assume it answers every question you asked, because it usually does: brief, reordered, or two in one clause all count. Put an id in "notCovered" only when nothing they wrote touches it. Never flag one for being short or not in the words you expected: telling them a reply you did receive did not count is wrong and insulting. FORKS ARE THE EXCEPTION: list every fork they answered in "answered", a fork decides which campaign this is, so silence leaves it open. A skipped question is not a refusal: ask again plainly, or proceed saying what you assume and its cost.
   AN ANSWER IS NOT AUTOMATICALLY A CLOSED DIMENSION. Your first questions are the opening pass, not a questionnaire to get through. Read every answer back against what you had, and decide which of these happened:
   - It ANSWERED the question. Record it, basis "user", and move on.
   - It NARROWED the question. Broad causes hide competing explanations underneath them — "cost hesitation" could be the interest rate, the total payable, the tenure, or the effect on available limit, and those lead to different messages. If the distinction would change the design, you now have a sharper question, not an answer.
   - It RAISED something new. Something volunteered may open a dimension you had not thought of. Record it and ask.
   - It made another dimension IRRELEVANT. Close that one with a note and stop asking about it.
   A BROAD CAUSE IS NEVER SETTLED BY BEING STATED. When they name why customers behave as they do, you have their belief, not a finding — and underneath it sit competing explanations that imply different campaigns. Record it as "user-belief" and close it exactly two ways: ASK which one it is, or TEST them against each other. Accepting it as given and designing for one reading is the third way, and it is wrong: it hides a choice you made on their behalf. Choose asking when the answer would change the design and they are likely to know; choose testing when they genuinely cannot know, and say which you did and why.
   Ask a follow-up ONLY when the answer would change the audience, the intervention, the timing, the experiment or the measure. A question whose every possible answer leads to the same campaign is not worth a turn of the user's time — say so and move on. Stopping is a decision you must make deliberately and state, not a limit you hit: there is no question count, and "nothing further would change this" is itself a finding.
   If they cannot answer, that is an answer too. Do not resolve it for them: carry it into the strategy as an unknown with its consequence, and consider whether an experiment could settle what the conversation could not.
   Update the dimension you already have, reusing its name EXACTLY. A rephrased near-duplicate loses the history of what was asked and what came back.

3. The business strategy, before any platform mapping.
   From the dimensions, settle the audience approach, the intervention, the timing and how success will be read — in business terms, in your own words. Do not narrow any of it to what the builder happens to support yet. Then map it: the sequence and entry event below are where implementation starts, and where a business intention that cannot be built becomes a stated limitation rather than a quiet omission.
   WHEN THE AUDIENCE YOU CAN BUILD IS NOT THE AUDIENCE THEY ASKED FOR, say all three things plainly, in the strategy itself:
   - who they intended to reach, in their words, and that it is theirs — keep any threshold or figure they gave you exactly as they said it, attributed to them;
   - who the campaign will actually reach once mapped to what exists;
   - what the difference costs, in reach or in relevance, and what would have to be resolved to close it.
   DO NOT CLOSE THAT GAP WITH A NEAR-ENOUGH ATTRIBUTE. An attribute that measures a different thing, or the same thing at a different grain, is not the one they asked for: a single event's value is not a running total, and one record's figure is not a customer's position. Calling it a proxy in a footnote does not make the targeting right — the campaign would still enter the wrong people. Leave the intended criterion unbuilt, say so, and let them decide.
   Never let the summary present the audience you CAN build as if it were the audience they asked for, and never describe the attribute you used in the words of the attribute you wanted. A campaign that quietly reaches a broader or narrower group than intended is the failure this step exists to prevent.

4. The sequence, before you pick an entry event.
   Work out what happens to the customer, in order, and where an intervention can still change the outcome. Several events may mention the same subject while sitting at different points in that sequence. Typically some of these exist, though not in every campaign:
   - the event where the opportunity appears (something became possible),
   - the event where the customer has already acted (a request now exists),
   - the event that proves success,
   - the event that closes the chance (expiry, failure, cancellation).
   Entry belongs where the behaviour you want has NOT happened yet and still can. The goal belongs on the event that proves it did. These are usually DIFFERENT events, often on different entities — and a condition can only use the attributes of the entity its category filters, so check that mapping before writing conditions.
   Never choose an event because its name shares a word with the objective. If two sources are genuinely plausible and the choice changes who enters, raise it as a strategic ambiguity and say which you would use.

5. The hypothesis.
   In one or two sentences: by what mechanism should this campaign change the behaviour — removing friction, surfacing a benefit, reminding someone of an unfinished action, arriving at a better moment? Be specific to this objective. It is a hypothesis, not a prediction.

6. The strategic options, before you settle the journey.
   BUILD TWO CANDIDATE ARCHITECTURES, THEN CHOOSE. An architecture is three things together: the entry and audience (who is reached), the mechanism (what behaviour it changes and by what means), and the triggering and timing logic (when it fires and what paces it). Record both in "architectures", with the trade-off each makes against the other, and mark the winner with why it won — citing what you were told, not a general preference.
   FEWER MESSAGES IS NOT A DIFFERENT APPROACH. Neither is a different tone, channel order or send count: those vary the same campaign. Two architectures differ when they reach DIFFERENT PEOPLE, at a DIFFERENT MOMENT, or by a DIFFERENT MEANS. Look for the second candidate before concluding there isn't one: it usually carries a factor the first cannot.
   EACH CANDIDATE MUST STATE ITS "barrier", "lever", "journey" AND "measurement". The barrier is the customer problem it addresses; the lever is what you do about it; "journey" is EXACTLY ONE OF ${JOURNEY_BEHAVIOURS.join(' | ')}. The application compares candidates on entry, timing and journey: if two of yours match on all three it records the comparison as INSUFFICIENT and tells the user, because two campaigns reaching the same people at the same moment with the same behaviour are one campaign described twice, whatever their mechanisms are called. It also checks the winner's declared "journey" against what you actually build.
   A FACTOR THE FIRST CANDIDATE CANNOT CARRY IS NOT A PLATFORM LIMITATION. Before you report any discovered factor as unbuildable, check whether a DIFFERENT entry would carry it. "This entry cannot express it" is a fact about the entry you chose, not about the platform. If a second architecture would carry a factor that matters, prefer it unless you have a stronger reason not to — and if you keep the first anyway, say plainly that you traded the factor away and what that costs. Only when neither candidate can carry it is it a limitation.
   Then take each option below and give it a verdict: "used" (it earns its place, and why), "not-applicable" (why this objective does not need it) or "cannot-evaluate" (what you would need to decide). Record all seven in "strategyOptions", one line each. An option you never considered and one you weighed and set aside both read as silence, so say which it was.
   - Segmentation. Does any dimension you found divide these customers into groups that deserve a DIFFERENT treatment, rather than one treatment for everyone? Name the groups and what would differ between them. Only call segmentation unavailable when no attribute can express the axis at all, never because nobody has named a number yet.
   - Experimentation. Is there a real competing hypothesis worth a controlled comparison? Say what is compared, how you would read the result, and what it would establish. Having no performance history is a reason TO test, not a reason to skip it: it stops you sizing an effect in advance, it does not stop you running the comparison. IF YOU CAN NAME THE ARMS, WRITE THEM — a test is never blocked on the user supplying copy, and asking them for message variants is asking them to do your job. Name the competing explanations, give each arm a real intervention and real copy, state the outcome you would read and the comparison you would read it against, and say what is missing if anything genuinely is. Only call an experiment unavailable when the journey cannot express it, never because nobody has written the words yet.
   - Conditional branching. Should what happens next depend on what the customer DID — converted, engaged but did not convert, or never engaged at all?
   - Channel fallback. What happens when delivery fails: retry, switch channel, or stop, and on what condition?
   - Adaptive sequencing. Should timing, channel or message change as the opportunity ages or as the customer responds?
   - Cost and fatigue. Weigh each additional message's incremental chance of converting against its cost and the irritation it adds. Name the weakest message and say why you kept or cut it.
   - Measurement and learning. What does this campaign teach, and against what comparison? Without a control group or a randomised comparison you can report what happened, never what the campaign CAUSED. Say which you have.
   Mark an option "used" only if the journey you are about to propose SHOWS it. A fixed chain of sends and waits is not adaptive sequencing however urgently its copy is worded; a fork whose branches do the same thing is not conditional branching; two experiment arms with the same steps are one treatment counted twice. The application checks these against your blueprint and will downgrade a claim it does not bear out, so claiming one you have not built only makes the answer less useful to read.
   Judge each on the business case, never on what the builder supports. Platform capability decides what gets BUILT, never what gets CONSIDERED: an option that is right for this business but unbuildable today is still recommended, kept in the strategy in full, with the limitation recorded separately. Never quietly downgrade it to a weaker thing the builder allows.

   SHOW WHERE EACH DECISION CAME FROM. Every entry in "approach" names what it rests on, inside the entry itself: what the user told you, what a tool reported, or that it is your own judgement with nothing confirming it. A reader must be able to tell THEIR requirements from YOUR recommendations without asking, and a decision that traces to nothing is an assumption — label it as one. If a later answer undercuts an approach you were heading towards, change it and say what changed it; never present a strategy that the accumulated answers no longer support.

7. The journey.
   Propose the simplest journey that does the job the approach you chose requires — simplest RELATIVE TO THAT STRATEGY, not fewest steps. If the strategy treats two groups differently, a journey that treats everyone the same is not simpler, it is a weaker strategy. There is no per-campaign message limit: how many messages to send is YOUR decision to justify, sized to how long the customer has and what closes the opportunity. Minimum spacing and quiet hours are real limits and must hold. Every step needs a reason, and every option you marked "used" should be visible in it. Do not add a branch, a reminder or an experiment because the builder supports one — and say what you considered and rejected.
   Recommend; do not hand the design back as a menu of questions.

8. The messages.
   Write each one as the CUSTOMER will read it. "copy" is the message itself, never a description of it and never an instruction to the campaign manager. Lead with what the customer gets, keep it short and plain, and put the action in "cta". Use \${customerFirstName} and \${shortUrl} where they help. Nothing you write is bank-approved, so never imply it is.

9. Honesty about what is settled.
   The working brief above separates what the user actually confirmed from what you assumed. Respect that line. If it lists an UNRESOLVED CONFLICT between something the user said and what the platform defines, do not design around it and do not substitute a different attribute or value for it: raise it, name the real alternatives, and let them choose. A value that is independently justified may stay — but the conflict is still theirs to resolve.

QUESTIONS AND OPEN ITEMS

"rejected" is for a decision you made between workable options. Something the platform CANNOT do is not a decision, and filing it there reads as "we chose against this" when the truth is "we could not express this" — keep it as the user's standing intent in "assumptions" or "unknowns", and raise the limitation. Ask only when the answer would change the design or is needed for a valid graph. Everything else gets a stated default. Never ask for message copy or CTA wording — write those yourself.

When you propose, list what is still open in "openItems", each with a kind:
- "strategic-ambiguity" — a business definition only the user can settle, which would change the design. Asked alongside your strategy.
- "evidence-gap" — aggregated data that would sharpen a decision. Never a prerequisite. The knowledge base already states no performance history exists for this bank, so do not ask for it again; note what would have helped and move on.
- "optional-preference" — a detail with a sensible default. Put the default in "ifUnanswered".
- "operational-limitation" — something the platform cannot confirm either way, which you can disclose and still recommend around.
A LIMITATION THAT REACHES THE WRONG CUSTOMER IS NOT A LIMITATION, IT IS A DECISION. If the audience you can build would message people who have already done the thing, or who were never meant to hear from you, that is not a footnote — someone will receive it. Say who would wrongly receive it and what that looks like to them, and raise it as a "strategic-ambiguity" so they decide, not as an "operational-limitation" you have quietly accepted on their behalf.
An open item never suppresses your recommendation, so classify honestly: there is nothing to gain by hiding one or inflating another.

Nothing is built until the user confirms it. Propose a complete, coherent strategy even when something is open: say what you assumed and what would change your mind.

OUTPUT

One JSON object, nothing else.

Propose only once the user has answered at least one question AND no dimension is still "open". Closing every dimension yourself on the first turn is not discovery: you looked things up, you did not find out what the user wants, and a proposal on a turn where they have said nothing back is rejected by the application and handed to you as more discovery. Check the record above before you write one:
{"action":"propose",
 "answered":["<ids answered; forks MUST appear here>"],
 "notCovered":["<ids untouched; usually empty>"],
 "questionResolutions":[{"questionId":"<id>","kind":"carried","why":"..."}],
 "dimensions":[{"name":"...","status":"retained","basis":"user","note":"<what was found or decided>"}],
 "contextChecked":[{"source":"<what you consulted>","found":true}],
 "converters":{...},"barriers":[{...}],
 "strategy":{"summary":"<2-4 sentences; max 5 bullets per list>","architectures":[{"name":"...","barrier":"<the customer problem>","lever":"<what you DO about it>","entry":"...","mechanism":"...","timing":"...","journey":"<EXACTLY ONE OF: linear | branch-on-response | wait-for-event | experiment>","measurement":"<what would show it worked>","tradeoff":"<what it gives up>","chosen":true,"whyChosen":"<cite the discovery record>"},{"name":"...","barrier":"...","lever":"...","entry":"...","mechanism":"...","timing":"...","journey":"<one of the four>","measurement":"...","tradeoff":"...","chosen":false}],"approach":["<decision + why>"],"strategyOptions":[{"option":"Segmentation","verdict":"used","why":"<one line>"},{"option":"Experimentation","verdict":"not-applicable","why":"..."},{"option":"Conditional branching","verdict":"...","why":"..."},{"option":"Channel fallback","verdict":"...","why":"..."},{"option":"Adaptive sequencing","verdict":"...","why":"..."},{"option":"Cost and fatigue","verdict":"...","why":"..."},{"option":"Measurement and learning","verdict":"...","why":"..."}],"rejected":[{"option":"<a materially different approach you CHOSE not to take>","why":"..."}],"successCriteria":["<what counts as this working>"],"measurement":["<what to track, how to judge it, what is missing>"],"assumptions":["..."],"unknowns":["..."],"hypotheses":["<worth testing, not claimed>"],"evidenceNotes":["..."]},
 "openItems":[{"kind":"strategic-ambiguity","question":"<what you need settled>","whyItMatters":"<what it would change>","ifUnanswered":"<what you will assume>"}],
 "blueprint":{
   "campaignName":"...","description":"...","controlPct":<number or omit>,
   "goal":{"eventCategory":"...","eventType":"...","conditions":[{"attribute":"...","operator":"Equals","value":"..."}]},
   "entry":{"kind":"event","eventCategory":"...","eventType":"...","conditions":[...]},
   "steps":[
     {"kind":"send","name":"...","objective":["<single lowercase words that would appear in the copy>"],"stage":"first-touch|reminder|outcome","describe":"<what this message is for>","copy":"<the message as the customer reads it>","cta":"<button or link text>","channelPreference":["SMS"],"barrier":"<barrier id it attacks>"},
     {"kind":"wait","durationHours":48,"why":"..."},
     {"kind":"waitForEvent","eventCategory":"...","eventType":"...","timeoutDays":7},
     {"kind":"exit","reason":"..."}
   ]}}

Optional step kinds: {"kind":"experiment","label":"...","tests":"wording|explanation|timing|audience","arms":[{"label":"A","pct":50,"steps":[...]},{"label":"B","pct":50,"steps":[...]}]} — "tests" is REQUIRED and says what the experiment can actually settle. Declare "wording" and the arms may differ only in what the messages say. Declare anything else and the arms must differ in something a customer would experience: different people, a different moment, different steps. The application checks this against the arms you built and REFUSES the proposal if they match, because an arm that behaves identically cannot tell you why a customer behaved differently. "wording" is always an honest option — a message test is a real test, it just cannot explain a cause. , {"kind":"condition","label":"...","outcomes":["DELIVERED"],"yes":[...],"no":[...]} — a fork on whether the LAST message landed, and {"kind":"condition","label":"...","on":{"entity":"Account","attribute":"Status","operator":"Equals","value":"Active"},"yes":[...],"no":[...]} — a fork on a CUSTOMER ATTRIBUTE read at that point, needing no preceding message, and {"kind":"branch","label":"...","entity":"Transaction","attribute":"Transaction Amount","paths":[{"label":"Large","operator":"Greater than","value":"25000","steps":[...]},{"label":"Small","operator":"Less than","value":"25000","steps":[...]}]} — N-WAY ROUTING ON ONE ATTRIBUTE, which is how a campaign treats cohorts differently anywhere other than at entry. These work mid-journey, so a group entry could not isolate still gets its own treatment. Entry may instead be {"kind":"audience","entity":"Customer","conditions":[...],"groups":[{"entity":"Account","conditions":[...]},{"entity":"Transaction","lookbackDays":180,"existence":"none"}]} — "groups" AND with the first, so entry CAN require several entities; a Transaction group with existence "none" excludes anyone who already did it (a window, not "ever").

DISCOVER FIRST. This is the normal opening move, and usually more than one round. Check what you can actually reach before you ask: call the tools, read the knowledge base and the bank context above, and report what you checked in "contextChecked" — one entry per source, with found true or false. Only name sources you genuinely consulted; you have no access to campaign history, analytics or bank systems, so never imply you looked there. Use it also when the objective is too vague to design against, or when a drip campaign is the wrong instrument for it entirely — say which, and why, in the rationale:
{"action":"ask","rationale":"<what you now understand, and why these questions matter to the design>","questions":[{"text":"...","impact":"fork","contingency":{"ifA":"<one plausible answer>","thenA":"<what you would do given it>","ifB":"<a materially different answer>","thenB":"<what you would do INSTEAD — must not be the same as thenA>","ifUnknown":"<the default you would apply if they cannot answer>"}},{"text":"...","impact":"detail"}],"answered":["<ids answered; forks required>"],"notCovered":["<ids untouched>"],"contextChecked":[{"source":"<what you consulted>","found":true}],"dimensions":[{"name":"...","rationale":"<why it could change THIS campaign>","status":"open","basis":"none"}],"converters":{"shape":"<their words>","basis":"user|user-belief","knowledge":"known|none-yet|unknown","candidates":[{"segment":"..","restsOn":"<what defines this group>","why":"<why it converts more>"}]},"barriers":[{"id":"..","statement":"..","basis":"user-belief","lever":"message|timing|targeting|not-addressable","quote":"<their actual words>"}]}
At most ${MAX_QUESTIONS_PER_ROUND} questions, and never one already answered.

Only when aggregated data would change a decision you are about to make, and the brief does not already say it is unavailable:
{"action":"request_evidence","rationale":"<what you are deciding and why this data matters>","evidence":[{"question":"<the business question it answers>","fields":["<metric>"],"grouping":"<how to bucket it>","period":"<time range>","wouldInform":"<what you would do differently>"}]}
Aggregated counts and rates only — never customer-level or personal data.`;

/**
 * Runs one turn of the conversation, emitting events as work happens.
 *
 * The generator yields RunEvents live (streamed to the browser) and returns
 * the final response. Crucially, graph construction is gated:
 *
 *   intent 'converse'  -> ask questions OR propose a strategy. NO graph.
 *   intent 'confirm'   -> build the already-proposed blueprint. No model call.
 *   refinement         -> a campaign already exists, so a revised proposal is
 *                         built immediately; the user is past confirmation.
 *
 * Previously the graph was built the moment the model said "propose", which
 * is why a completed campaign appeared before anyone had agreed the strategy.
 */
export async function* orchestrateStream(
  req: OrchestratorRequest,
): AsyncGenerator<RunEvent, OrchestratorResponse> {
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const events: RunEvent[] = [];
  const pending: RunEvent[] = [];
  const em = new EventEmitterSeq(runId, (e) => {
    events.push(e);
    pending.push(e);
  });
  // Yields everything buffered since the last drain, preserving order.
  const drain = function* () {
    while (pending.length) yield pending.shift()!;
  };

  const isRefinement = Boolean(req.currentCampaign);
  // Defined once, here, and passed down. A turn either BUILDS something or it
  // does not, and the context builder and the propose path must never
  // disagree about which this is.
  const isBuildTurn = (req.intent ?? 'converse') === 'confirm' || isRefinement;
  const intent = req.intent ?? 'converse';
  const latestUserText = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const firstUserText = req.messages.find((m) => m.role === 'user')?.content ?? latestUserText;

  // The accumulated brief and the state machine. Both are the APPLICATION's
  // record, not the model's — they are what discovery is evaluated against.
  // A limitation stated in the opening brief counts. A live run had the user
  // say "we have no historical conversion data of any kind" in their very
  // first message; because the capture only ran on follow-up turns, it was
  // never recorded and the strategy carried the constraint in prose only.
  let brief: WorkingBrief = req.brief ?? noteVolunteeredLimitation(newBrief(firstUserText), firstUserText);
  let session: SessionState = req.session ?? newSession();

  // Is the user answering a question we asked, or saying something new?
  //
  // This ordering matters and was a real bug: an ANSWER shares almost no
  // vocabulary with the objective ("Entry status is Initiated" vs "customers
  // are not converting"), so checking for a changed objective first treated
  // every answer as a brand-new brief and wiped the accumulated discovery.
  // An outstanding question means the message is an answer, full stop.
  const awaitingAnswer = brief.questions.some((q) => q.answeredInRound === undefined);

  // Everything the user asserts is checked against platform metadata as it
  // arrives. A value the platform cannot represent becomes a conflict the
  // agent must raise, not something to quietly design around.
  if (intent === 'converse' && latestUserText) {
    brief = {
      ...brief,
      statedValues: mergeStatedValues(brief.statedValues ?? [], detectStatedValues(latestUserText)),
    };
  }

  if (req.brief && intent === 'converse') {
    const awaitingEvidence = brief.evidenceRequests.some((e) => e.status === 'pending');
    if (awaitingEvidence) {
      // Resolve the data request first — a reply of "we don't have that" is
      // a valid answer that must stop the agent asking again.
      brief = resolveEvidence(brief, latestUserText);
      if (awaitingAnswer) brief = recordAnswer(brief, latestUserText);
    } else if (awaitingAnswer) {
      brief = recordAnswer(brief, latestUserText);
      // The user may volunteer that data does not exist without having been
      // asked for it. Capture that as a limitation so the strategy carries it.
      brief = noteVolunteeredLimitation(brief, latestUserText);
    } else if (objectiveChangedMaterially(brief.objective, latestUserText)) {
      // The CONFIRMATION is withdrawn. The discovery is not thrown away.
      //
      // This used to rebuild the brief from whatever had just been typed —
      // `{ ...newBrief(latestUserText), answers: brief.answers }` — which
      // deleted every established fact, every dimension and every recorded
      // limitation, and replaced the objective with the new sentence.
      // Measured: asking "what conversion rate should we expect?" scored
      // 0.067 against the 0.5 threshold and wiped a brief holding the user's
      // own confirmed entry-trigger decision.
      //
      // The test cannot be made reliable, so its consequence is made
      // proportionate instead. On a domain-mixed corpus, clarifications and
      // constraints score 0.000-0.067 while genuinely different objectives
      // score 0.000-0.125: overlapping ranges, with a real change scoring
      // HIGHER than the worst clarification, and six clarifications sitting
      // at exactly 0.000 alongside two real changes. No threshold separates
      // them, and neither does a question mark — "Our target is a 5% uplift."
      // has none.
      //
      // So: withdraw the approval, which is reversible and the conservative
      // direction, and keep what was learned. A user genuinely starting a
      // different campaign has an explicit reset in the UI; the application
      // no longer guesses on their behalf and deletes their work.
      session = invalidateConfirmation({
        ...session,
        state: 'UNDERSTANDING_GOAL',
        strategyVersion: session.strategyVersion + 1,
      });
      em.emit('stage.started', 'understanding', 'Objective may have changed', {
        detail: 'The previous strategy confirmation no longer applies. Everything already established is kept.',
      });
    }
  }

  const base: OrchestratorResponse = {
    sessionId: req.sessionId,
    runId,
    phase: 'understanding',
    stage: 'discovery',
    reply: '',
    questions: [],
    strategy: null,
    blueprint: null,
    pendingBlueprint: null,
    brief: null,
    session: null,
    evidenceRequests: [],
    graphReadiness: null,
    designGenerated: false,
    importReadiness: null,
    campaign: null,
    graph: null,
    provenance: null,
    unresolvedCampaignFields: [],
    campaignBlockers: [],
    validation: null,
    buildIssues: [],
    templateChoices: [],
    sendProposals: [],
    discoveryRounds: req.discoveryRounds,
    discoveryLimitReached: req.discoveryRounds >= MAX_DISCOVERY_ROUNDS,
    exportable: false,
    events,
    model: 'unknown',
  };

  // `status: 'running'`, not the emitter's default of 'ok'. This is the
  // announcement that work has BEGUN, and it was rendering with a green tick
  // the instant the first message was sent — a completed step that had done
  // nothing. It is resolved by `run.completed` below, which shares its
  // correlation id so the two collapse into one row rather than stacking.
  // The label follows the PHASE. It used to be a two-way ternary written when
  // every turn was a design turn, so discovery announced itself as "Starting
  // campaign design" — while the builder's vocabulary was being deliberately
  // withheld from that very turn. Nothing is being designed on turn one.
  em.emit(
    'run.started',
    'understanding',
    isRefinement ? 'Applying your change' : isBuildTurn ? 'Building the campaign' : 'Working out what you need',
    {
      status: 'running',
      correlationId: 'run',
    },
  );
  yield* drain();

  let model: string;
  try {
    model = resolveModel();
    base.model = model;
  } catch (e) {
    em.emit('run.failed', 'understanding', 'Configuration error', { correlationId: 'run', status: 'failed', detail: (e as Error).message });
    yield* drain();
    // EVERY failure echoes the brief and session back unchanged.
    //
    // `base` carries brief:null/session:null, so returning it bare told the
    // client to discard the accumulated discovery — every established fact,
    // question, answer and the state machine itself. A failed turn must be a
    // no-op, not a reset: "You can retry" is only true if there is something
    // left to retry from.
    return { ...base, phase: 'error', stage: 'error', reply: (e as Error).message, brief, session };
  }

  // --- tenant, resolved server-side ----------------------------------
  const tenant: TenantConfig | null = resolveTenant(req.tenantId);
  if (!tenant) {
    const msg = req.tenantId
      ? `Unknown tenant "${req.tenantId}". Pick a tenant in the header.`
      : 'No tenant selected. Pick a tenant in the header before designing a campaign.';
    em.emit('run.failed', 'understanding', 'No tenant selected', { correlationId: 'run', status: 'failed', detail: msg });
    yield* drain();
    return { ...base, phase: 'error', stage: 'error', reply: msg, brief, session };
  }

  const bank = bankContext();
  const availableChannels = tenant.availableChannels
    .filter((c) => c.available)
    .sort((a, b) => a.relativeCost - b.relativeCost)
    .map((c) => c.channel as Channel);

  // ===================================================================
  // CONFIRMATION PATH — the user agreed the strategy, so build it.
  // ===================================================================
  if (intent === 'confirm' && req.confirmedBlueprint) {
    // The confirmation must be recorded against the brief and strategy that
    // were ON SCREEN when the user agreed — which is the strategy the client
    // echoes back. Stamping it with the CURRENT fingerprint first would make
    // the staleness check compare a value against itself and always pass;
    // that bug let a confirmation survive a changed objective.
    const confirmedFor = fingerprint(
      (req.confirmedBlueprint?.description ?? '') + ' ' + (req.confirmedStrategy?.summary ?? ''),
    );
    const briefMatchesStrategy =
      !confirmedFor || overlaps(confirmedFor, brief.objectiveFingerprint) || !req.brief;

    session = {
      ...session,
      state: session.state === 'STRATEGY_READY' ? 'AWAITING_STRATEGY_CONFIRMATION' : session.state,
      confirmation: briefMatchesStrategy
        ? {
            objectiveFingerprint: brief.objectiveFingerprint,
            strategyVersion: session.strategyVersion,
            confirmedAt: new Date().toISOString(),
          }
        : null,
    };
    const permitted = briefMatchesStrategy
      ? mayGenerate(session, brief.objectiveFingerprint)
      : {
          ok: false as const,
          reason:
            'The objective changed after this strategy was proposed, so confirming it would build the wrong campaign. Describe what you want now and the agent will revisit the strategy.',
        };
    if (!permitted.ok) {
      em.emit('run.failed', 'strategy', 'Cannot generate yet', { correlationId: 'run', status: 'failed', detail: permitted.reason });
      yield* drain();
      return { ...base, phase: 'awaiting-confirmation', stage: 'proposed', reply: permitted.reason, brief, session };
    }
    session = { ...session, state: transition(session.state, 'GENERATING_CAMPAIGN') };
    em.emit('strategy.confirmed', 'generating', 'Strategy confirmed', {
      detail: 'Building the campaign with the application\'s own graph logic.',
    });
    yield* drain();
    const out = buildAndValidate(req, tenant, bank, availableChannels, req.confirmedBlueprint, req.confirmedStrategy ?? null, em);
    yield* drain();
    const nextState: CampaignState = out.exportable ? 'EXPORT_ELIGIBLE' : 'CONFIGURATION_INCOMPLETE';
    session = { ...session, state: transition(session.state, nextState) };
    return { ...base, ...out, phase: out.stage === 'error' ? 'error' : 'review', brief, session };
  }

  // ===================================================================
  // CONVERSATION PATH — context, then a streamed model turn with tools.
  // ===================================================================
  const t0 = Date.now();
  em.emit('context.retrieval.started', 'understanding', 'Gathering context', { status: 'running', correlationId: 'context' });
  yield* drain();

  const caps = loadCapabilities();
  const kbText = knowledgeForPrompt(req.knowledge, tenant.tenantId);
  const docsUsed = (req.knowledge.documents ?? []).filter(
    (d) => d.status === 'ready' && d.text && (d.scope === 'shared' || d.scope === tenant.tenantId),
  );
  // What was ACTUALLY supplied this turn, not what could have been.
  //
  // This line used to report "Platform capabilities (11 step types, 4
  // channels)" on every turn including the first — while the builder's
  // vocabulary was being deliberately withheld from that same prompt. The
  // activity timeline was claiming the agent had been given something it had
  // not. An observability surface that reports the intent rather than the
  // fact is worse than none, because it is believed.
  const sources = [
    isBuildTurn
      ? `Platform capabilities (${caps.nodeTypes.length} step types, ${caps.channels.length} channels)`
      : `Channels and templates for ${tenant.displayName} — the builder's vocabulary is withheld until a plan is approved`,
    `Campaign principles and bank context for ${tenant.displayName} (${req.knowledge.entries.length} entries, synthetic)`,
    ...docsUsed.map((d) => `Document: ${d.filename}`),
  ];
  em.emit('context.retrieval.completed', 'understanding', 'Context gathered', {
    correlationId: 'context',
    detail: sources.join(' · '),
    durationMs: Date.now() - t0,
    data: {
      sources,
      knowledgeVersion: req.knowledge.version,
      documentsUsed: docsUsed.map((d) => ({ filename: d.filename, scope: d.scope })),
      tenantId: tenant.tenantId,
      templateLibraryAccess: tenant.templateLibraryAccess,
    },
  });
  yield* drain();

  const limitReached = req.discoveryRounds >= MAX_DISCOVERY_ROUNDS || Boolean(req.forceProposal);
  const context = buildContextPrompt(req, brief, tenant, kbText, availableChannels, limitReached, isRefinement, isBuildTurn);

  const conversation: ApiMessage[] = [
    { role: 'user', content: context },
    ...req.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  let assistantText = '';
  let usage: { input_tokens?: number; output_tokens?: number } | undefined;
  let stopReason: string | undefined;

  // Tool rounds: the model may call tools, we execute them server-side and
  // hand the results back, until it produces its answer.
  //
  // MAX_TOOL_ROUNDS is a real limit, so the last round tells the model to
  // stop looking things up and answer. Without that nudge a model that kept
  // calling tools simply ran out of rounds and produced no JSON at all — the
  // failure then surfaced as "unparseable", which pointed at the wrong cause.
  const MAX_TOOL_ROUNDS = 8;
  // Results already fetched this run, keyed by tool + input. Every tool here
  // is deterministic and most take no arguments, so a second identical call
  // cannot return anything new.
  //
  // A live run spent all eight rounds this way: list_event_types four times,
  // list_audience_attributes three, list_step_types twice — then failed with
  // "too many lookups" and showed the user nothing at all. Capping the loop
  // harder would have produced the same empty result sooner; the repeat is
  // what has to stop.
  const toolCache = new Map<string, ReturnType<typeof runTool>>();
  /** Which round first answered each lookup, so a repeat can be pointed back at it. */
  const toolRounds = new Map<string, number>();
  // A round that asked only for things it already had earns the "stop looking
  // things up" instruction early. That is a NUDGE, deliberately separate from
  // the budget: conflating the two was a real defect — a single repeated
  // lookup on round 2 made round 3 the "last" round, and a model that asked
  // for one more tool there had its whole run failed as "too many lookups"
  // five rounds before the budget was actually spent.
  // ONE repeated-lookup round is no longer enough to withdraw tool use.
  //
  // MEASURED, across five recorded runs with per-round event data. In every
  // run where a round's tool calls were ALL cache repeats, the next round —
  // the one sent with tool_choice 'none' plus a "stop calling tools"
  // instruction — came back with a thinking block, no text and stop_reason
  // end_turn. In every run where that path did not fire, the model stopped
  // calling tools on its own and answered normally:
  //
  //   df2 t1, df2 t2, osdiag t2   no all-repeat round   -> readable answer
  //   att2, att3                  one all-repeat round  -> EMPTY response
  //
  // Those empty rounds spent 14 and 25 thinking tokens against a 16,000
  // max_tokens, so neither a thinking budget nor truncation explains them.
  // The same failure signature is recorded in the comment below for the
  // earlier attempt that dropped the tool definitions outright.
  //
  // So the repeat signal now relies on what the tool result already says —
  // "you already called this in this run and the result is unchanged" — and
  // withdrawal is kept as the bounded fallback if the model ignores it twice
  // in a row. Both observed failures had exactly ONE all-repeat round.
  const MAX_REPEAT_ROUNDS = 2;
  let repeatRounds = 0;
  /** One recovery attempt per run, never a loop. */
  /**
   * How many times this turn has re-asked after an unusable answer.
   *
   * Two, not one. A single retry was the product's entire tolerance while the
   * evaluation harness retried the same turn SIX times — so every recorded
   * run had six chances to answer and a real conversation had one, and the
   * failure that ends a user's session was invisible in every measurement of
   * it. Two in-turn attempts plus the UI's own one gives roughly the harness's
   * patience without matching its willingness to hide a persistent fault.
   */
  const MAX_EMPTY_RECOVERIES = 2;
  let emptyRecoveries = 0;
  // The design step's state, read again after the loop so the gap can be
  // rendered to the user and checked against what was finally built.
  let designSeen = false;
  let designDemanded = false;
  let designRequirements: CapabilityRequirement[] = [];
  let designVerdicts: RequirementVerdict[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const budgetSpent = round === MAX_TOOL_ROUNDS - 1;
    const stopLookingUp = budgetSpent || repeatRounds >= MAX_REPEAT_ROUNDS;
    const callStart = Date.now();
    // One row per model round, correlated so it resolves in place.
    //
    // Without this, 'Agent thinking' and 'Agent responded' were two separate
    // rows: the first spun for ever because nothing ever completed it, and
    // the second appeared beside it with a tick. A turn with four rounds
    // showed four permanent spinners next to four ticks, which reads as four
    // things still running after the agent has finished and replied.
    const roundId = `model-round-${round}`;
    em.emit('model.started', isRefinement ? 'review' : 'discovery', round === 0 ? 'Agent thinking' : 'Agent continuing', {
      status: 'running',
      correlationId: roundId,
      detail: round === 0 ? undefined : `after tool results (round ${round + 1})`,
    });
    yield* drain();

    const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
    let turnContent: unknown[] = [];
    let turnDiagnostics: { blockTypes: string[]; textChars: number; textFromDeltas: number; toolUses: number } | undefined;
    assistantText = '';

    try {
      for await (const chunk of streamClaude({
        system: stopLookingUp
          ? `${systemForPhase(isBuildTurn)}\n\nSTOP CALLING TOOLS. Every lookup you need has already been made and the results are above. Answer now with the JSON object, using what you already know.`
          : systemForPhase(isBuildTurn),
        messages: conversation,
        // Once there is nothing left to look up, tool USE is withdrawn rather
        // than discouraged. Asking a model to stop calling tools is a request
        // it can decline, and it did: a live run spent rounds 2, 3 and 4
        // re-fetching results it already had, at roughly 45 seconds a round,
        // until the budget ran out and the user got an error instead of a
        // strategy.
        //
        // The DEFINITIONS still travel. Dropping them was the first attempt
        // and it was wrong: the conversation by then contains tool_use and
        // tool_result blocks, and sending that history with no tools made the
        // model return an empty turn — three of the first four evaluation
        // scenarios died that way, reported as "no text at all". tool_choice
        // 'none' forbids the call while keeping the history coherent.
        tools: toolsForPhase(designSeen).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        toolChoice: stopLookingUp ? { type: 'none' } : undefined,
        // The round that must produce the answer runs WITHOUT thinking. See
        // `disableThinking` in anthropic.ts for the measurement: with it on,
        // this round returned a thinking block and no text 3 times out of 3.
        // Nothing here needs reasoning out — every lookup is already in the
        // history, and the job is to write the answer down.
        disableThinking: stopLookingUp,
        // 32000, raised from 16000. MEASURED, not guessed: a live turn came
        // back with stopReason 'max_tokens' at exactly 16000 output tokens,
        // and three neighbouring turns landed on 15722, 15579 and 15034 —
        // sitting against the ceiling. A response cut off mid-JSON surfaces
        // as "did not return parseable JSON", and one cut off before any text
        // escapes surfaces as an empty turn, which is why this looked like
        // two unrelated intermittent faults for most of a day.
        //
        // It got worse today because the required payload grew: converters,
        // candidates and barriers now ride on every answer alongside the
        // strategy, the blueprint and the dimensions. Asking for more output
        // without raising the ceiling is what turned an occasional failure
        // into four rounds in a row.
        maxTokens: 32000,
      })) {
        if (chunk.text) {
          assistantText += chunk.text;
          // Forwarded exactly as the provider sent it.
          em.emit('model.text.delta', isRefinement ? 'review' : 'discovery', 'delta', {
            status: 'running',
            data: { text: chunk.text },
          });
          yield* drain();
        }
        if (chunk.toolUse) {
          toolUses.push(chunk.toolUse);
          em.emit('model.tool_call.requested', 'understanding', toolTitle(chunk.toolUse.name), {
            status: 'running',
            correlationId: chunk.toolUse.id,
            data: { tool: chunk.toolUse.name, input: chunk.toolUse.input },
          });
          yield* drain();
        }
        if (chunk.diagnostics) turnDiagnostics = chunk.diagnostics;
        if (chunk.done) {
          turnContent = chunk.done.content;
          usage = chunk.done.usage;
          stopReason = chunk.done.stopReason;
          // The assembled blocks are authoritative. Deltas are for live
          // rendering, and a text block that arrives complete produces none —
          // relying on them alone reported a real answer as an empty one.
          assistantText = chunk.done.text || assistantText;
        }
      }
    } catch (e) {
      const msg = e instanceof AnthropicConfigError ? e.message : `The agent could not complete: ${(e as Error).message}`;
      em.emit('model.failed', 'discovery', 'Agent call failed', { status: 'failed', detail: msg });
      em.emit('run.failed', 'discovery', 'Run failed', { correlationId: 'run', status: 'failed' });
      yield* drain();
      return { ...base, phase: 'error', stage: 'error', reply: msg, brief, session };
    }

    em.emit('model.completed', isRefinement ? 'review' : 'discovery', 'Agent responded', {
      correlationId: roundId,
      durationMs: Date.now() - callStart,
      // Block TYPES and counts only. No block contents, so the model's
      // reasoning cannot reach an event, the run log or the browser.
      data: { usage, stopReason, toolCalls: toolUses.length, round: round + 1, ...turnDiagnostics },
    });
    yield* drain();

    // A terminal round that said nothing. One bounded recovery attempt, with
    // thinking off and tool use forbidden, before anyone sees an error.
    //
    // This is the backstop for the case `disableThinking` above does not
    // cover: a round that ends of its own accord, without the repeat limit or
    // the budget having withdrawn tools. Bounded to a single extra call, and
    // only when there is genuinely nothing to show — never on a round that
    // produced text or asked for a tool.
    // Unusable, not merely absent. Measured after the thinking fix landed: the
    // withdrawal round stopped returning nothing (0 chars became 115-828 in
    // every withdrawal case) but often returned a short prose sentence instead
    // of the JSON object. Both are the same failure from the user's side —
    // they asked a question and got nothing they can act on.
    const unusable = !assistantText.trim() || !extractJson(assistantText, stopReason).ok;
    if (!toolUses.length && unusable && emptyRecoveries < MAX_EMPTY_RECOVERIES) {
      emptyRecoveries++;
      em.emit('model.started', isRefinement ? 'review' : 'discovery', 'Agent answer unusable, asking again', {
        status: 'running',
        detail: assistantText.trim()
          ? 'The turn produced text that was not the expected JSON. Retrying once.'
          : 'The turn ended with no answer at all. Retrying once.',
      });
      yield* drain();
      const retryStart = Date.now();
      try {
        for await (const chunk of streamClaude({
          system: `${systemForPhase(isBuildTurn)}\n\nYour previous turn did not produce a usable answer. Every lookup you need has already been made and the results are above. Reply NOW with the single JSON object described in OUTPUT, complete, and nothing else before or after it.`,
          messages: conversation,
          tools: toolsForPhase(designSeen).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
          toolChoice: { type: 'none' },
          disableThinking: true,
          maxTokens: 32000,
        })) {
          if (chunk.text) assistantText += chunk.text;
          if (chunk.done) {
            turnContent = chunk.done.content;
            usage = chunk.done.usage;
            stopReason = chunk.done.stopReason;
            assistantText = chunk.done.text || assistantText;
          }
        }
      } catch {
        // Fall through: the empty-response error below is the honest outcome.
      }
      em.emit('model.completed', isRefinement ? 'review' : 'discovery', 'Agent responded', {
      correlationId: roundId,
        durationMs: Date.now() - retryStart,
        data: { usage, stopReason, toolCalls: 0, round: round + 1, retryOfEmptyRound: true, textChars: assistantText.length },
      });
      yield* drain();
      break;
    }

    if (!toolUses.length) {
      // THE DESIGN STEP. The intervention is stated before any blueprint
      // exists, and the application — not the agent's prose — answers what the
      // platform can do about it.
      //
      // Done here, inside the model loop, so it costs no extra user turn: it
      // is a second model round within the same turn, exactly as a tool result
      // is. Doing it as part of the propose payload would not work, because a
      // model writing both in one breath describes an intervention that
      // happens to match what it built. The whole value is in the ordering.
      const peek = extractJson(assistantText, stopReason);
      const act = peek.ok ? (peek.value as { action?: string }).action : undefined;

      // GATED ON A BUILD TURN. The capability check is the third way the
      // platform used to speak during discovery, and the last one found.
      //
      // MEASURED, same scenario, one run: turns 1-3 asked what stops
      // customers converting and which group was likelier to convert. From
      // turn 4 — the first turn this block fired — the questions became "there
      // is no way to filter entry to customers who actually have an
      // outstanding balance" and "three gaps change who gets reached". The
      // vocabulary had already been removed from the context and the lookup
      // tools withheld; this path was still handing the model a verdict about
      // what the builder supports, and it reasoned from it immediately.
      //
      // Stating the intervention before building is still right, and the
      // tests pinning this block inside the model loop still hold. It simply
      // belongs on the turn where something is being built.
      if (act === 'design' && !designSeen && peek.ok && isBuildTurn) {
        designSeen = true;
        // Requirements are derived from the INTERVENTION and the ELIGIBILITY
        // list, not asked for as a separate `requirements` array.
        //
        // WHY THE SHAPE CHANGED. The old payload asked for
        // `{need, attribute, event}` under `entryEntity`, and that schema was
        // the reason three of four stated requirements came back as audience
        // plumbing: a slot pairing a need with "the attribute that expresses
        // it" only comfortably accepts needs that HAVE an attribute. A real
        // conversion requirement — "they think it is expensive, so the first
        // message has to reframe the cost" — has no attribute and no event,
        // so the schema pushed it out. Asking for the intervention in terms
        // of barriers and mechanisms, and keeping eligibility in its own box,
        // removes that pressure.
        //
        // `does` goes into BOTH `need` and `attribute` deliberately:
        // `attributesIn` scans free text for real attribute names rather than
        // expecting a bare one, which is the fix that made this check work at
        // all — the agent writes whole filter expressions, not field names.
        const peeked = peek.value as {
          intervention?: unknown;
          eligibility?: { entity?: unknown; exclude?: unknown };
        };
        const fromIntervention = Array.isArray(peeked.intervention)
          ? peeked.intervention
              .map((r) => r as Record<string, unknown>)
              .filter((r) => r && typeof r.does === 'string' && r.does.trim())
              .map((r) => ({
                need: String(r.does).trim(),
                attribute: String(r.does).trim(),
                event: typeof r.mechanism === 'string' && r.mechanism === 'wait' ? String(r.does) : undefined,
              }))
          : [];
        // Eligibility is still capability-checked — it just is not put to the
        // user as a choice. An exclusion the platform cannot express becomes a
        // limitation on the built campaign, not a question.
        const fromEligibility = Array.isArray(peeked.eligibility?.exclude)
          ? (peeked.eligibility.exclude as unknown[])
              .filter((x): x is string => typeof x === 'string' && !!x.trim())
              .map((x) => ({ need: `Exclude: ${x.trim()}`, attribute: x.trim(), event: undefined }))
          : [];
        designRequirements = [...fromIntervention, ...fromEligibility];
        const entity = typeof peeked.eligibility?.entity === 'string' ? String(peeked.eligibility.entity) : null;
        designVerdicts = evaluateCapability(designRequirements, entity);
        em.emit('validation.started', 'understanding', 'Checking the intervention against the platform', {
          // 'ok', not 'warn'. RunEvent['status'] is running|ok|failed and
          // never had a 'warn' — this was the only emit anywhere using it, so
          // it reached the run log as an unrecognised status. A capability gap
          // is not a failure either: the design carries on and the count below
          // says what could not be met.
          status: 'ok',
          detail: `${capabilityGaps(designVerdicts).length} of ${designVerdicts.length} requirements cannot be met at entry`,
          data: { verdicts: designVerdicts },
        });
        yield* drain();
        conversation.push({ role: 'assistant', content: assistantText });
        conversation.push({ role: 'user', content: briefBackCapability(designVerdicts, designRequirements) });
        continue;
      }

      // A proposal that skipped the design step is sent back once. Once only:
      // a guard with no way out is a deadlock, and this codebase has already
      // paid for that lesson with a five-turn run that never proposed.
      if (act === 'propose' && !designSeen && !designDemanded && isBuildTurn) {
        designDemanded = true;
        conversation.push({ role: 'assistant', content: assistantText });
        conversation.push({
          role: 'user',
          content:
            'Before the campaign: state the INTERVENTION on its own, as {"action":"design","intervention":[{"barrier":"<a barrier id from your own list>","does":"<what the journey does about it>","mechanism":"message|timing|branch|experiment|wait"}],"eligibility":{"entity":"<the entity you would filter, or null>","exclude":["<who must never receive this>"]}}. Every entry must attack a named barrier. Describe what would actually work, not what you already know is buildable. I will tell you what this platform can do about it, and then you build.',
        });
        continue;
      }
      break;
    }
    // Only a spent budget ends the run. A nudged round that still asks for a
    // tool simply continues.
    if (budgetSpent) {
      em.emit('model.failed', 'discovery', 'Too many lookups', {
        status: 'failed',
        detail: `The agent kept requesting tools after ${MAX_TOOL_ROUNDS} rounds and did not produce an answer.`,
      });
      em.emit('run.failed', 'discovery', 'Run failed', { correlationId: 'run', status: 'failed' });
      yield* drain();
      return {
        ...base,
        phase: 'error',
        stage: 'error',
        reply:
          'The agent spent all of its lookups without reaching an answer. Retry — adding a little more detail to your brief usually resolves it.',
        brief,
        session,
      };
    }

    // Execute every requested tool, server-side, and report what happened.
    conversation.push({ role: 'assistant', content: turnContent });
    const results: unknown[] = [];
    let repeats = 0;
    for (const tu of toolUses) {
      const started = Date.now();
      em.emit('model.tool_call.started', 'understanding', toolTitle(tu.name), {
        status: 'running',
        correlationId: tu.id,
      });
      yield* drain();
      const key = `${tu.name}:${JSON.stringify(tu.input ?? {})}`;
      const cachedAt = toolRounds.get(key);
      const cached = toolCache.get(key);
      const out = cached ?? runTool(tu.name, tu.input, { tenant });
      if (cached) repeats++;
      else {
        toolCache.set(key, out);
        toolRounds.set(key, round + 1);
      }
      em.emit(out.ok ? 'model.tool_call.completed' : 'model.tool_call.failed', 'understanding', toolTitle(tu.name), {
        status: out.ok ? 'ok' : 'failed',
        detail: cached ? `${out.summary} (already fetched this run)` : out.summary,
        durationMs: Date.now() - started,
        correlationId: tu.id,
        data: out.result,
      });
      yield* drain();
      // Identical result, plus a plain statement that it is identical. The
      // model is not punished for asking twice; it is told there is nothing
      // further to learn here.
      // A FIRST call gets the data. An IDENTICAL repeat gets a pointer to
      // where the data already is, not a second copy of it.
      //
      // MEASURED on real runs, not inferred. Every repeat was byte-identical
      // (`list_event_types` and `list_audience_attributes`, both with input
      // `{}`, exact cache-key match), and truncation was not the cause: the
      // largest payload is 5,482 chars against an 8,000 limit. The model had
      // the complete answer and asked again anyway — and the old branch
      // rewarded it with the full payload a second time, so re-asking cost it
      // nothing and read like a fresh lookup. Two whole rounds, 20-45s each,
      // went on re-reading what was already in the conversation.
      //
      // The original result stays exactly where it was in the history, so
      // nothing is lost: the pointer says which round to look in.
      const payload = JSON.stringify(out.result).slice(0, 8000);
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: cached
          ? `No new data. You already called ${tu.name} with these exact arguments in round ${cachedAt ?? 1}, and its full result is in this conversation above — read it there. Calling it again cannot return anything different. Use what you already have and answer.`
          : payload,
      });
    }
    // Consecutive, so one stray repeat between useful rounds does not escalate.
    repeatRounds = repeats === toolUses.length ? repeatRounds + 1 : 0;
    conversation.push({ role: 'user', content: results });
  }

  // --- interpret the answer ------------------------------------------
  // `dimensions` rides on EVERY action, not just one: the agent records what
  // it is considering as it goes, and the gate reads that record rather than
  // the model's own claim to be finished.
  //
  // `converters` and `barriers` ride along for the same reason, and they are
  // the two findings discovery exists to produce: who converts today, and why
  // the rest do not. Both arrive on an `ask` turn as readily as a `propose`
  // one, because the answer usually comes mid-conversation rather than at the
  // end.
  const parsed = extractJson<
    | { action: 'ask'; rationale?: string; questions: (string | { text: string; impact?: QuestionImpact })[]; dimensions?: DimensionUpdate[]; contextChecked?: { source: string; found: boolean }[]; answered?: string[]; notCovered?: string[]; questionResolutions?: QuestionResolution[]; converters?: Converters; barriers?: Barrier[] }
    | {
        action: 'request_evidence';
        rationale?: string;
        evidence: { question: string; fields: string[]; grouping?: string; period?: string; wouldInform: string }[];
        dimensions?: DimensionUpdate[];
        contextChecked?: { source: string; found: boolean }[];
        answered?: string[]; notCovered?: string[]; questionResolutions?: QuestionResolution[]; converters?: Converters; barriers?: Barrier[];
      }
    | {
        action: 'propose';
        strategy: Strategy;
        blueprint: CampaignBlueprint;
        openItems?: OpenItem[];
        dimensions?: DimensionUpdate[];
        contextChecked?: { source: string; found: boolean }[];
        answered?: string[]; notCovered?: string[]; questionResolutions?: QuestionResolution[]; converters?: Converters; barriers?: Barrier[];
      }
  >(assistantText, stopReason);

  /**
   * The prose part of an answer, ignoring any JSON that follows it.
   *
   * Server-side on purpose. The designer has its own copy for streaming, and
   * reaching across to src/ from here would couple the agent to the UI.
   */
  const proseBefore = (text: string): string => {
    const brace = text.indexOf('{');
    return (brace === -1 ? text : text.slice(0, brace)).trim();
  };

  if (!parsed.ok) {
    // IF IT SAID SOMETHING READABLE, SAY IT. Only error when it did not.
    //
    // The recovery round above runs with toolChoice 'none' and thinking
    // disabled, and this project already measured what that produces: it
    // stops returning nothing, and "often returns a short prose sentence
    // instead of the JSON object". That sentence was then thrown away for
    // failing to parse, and the user — eight turns into a real conversation —
    // got "the model returned no text at all. You can retry."
    //
    // A plain answer is worth incomparably more than that error. It cannot be
    // built into a campaign, so discovery simply continues and nothing is
    // recorded as settled on the strength of unparsed text. The failure is
    // still emitted for the run log, because this IS a defect and hiding it
    // in the record would be the wrong kind of graceful.
    const prose = proseBefore(assistantText);
    const readable = prose.length > 80 && !prose.startsWith('{') && !prose.startsWith('[');
    em.emit('model.failed', 'discovery', 'Could not read the agent\'s answer', {
      status: 'failed',
      detail: readable ? `${parsed.error} Showing its plain reply instead.` : parsed.error,
    });
    if (readable) {
      em.emit('run.completed', 'discovery', 'Waiting for your answer', { correlationId: 'run' });
      yield* drain();
      return { ...base, phase: 'discovery', stage: 'discovery', reply: prose, brief, session, strategy: null, blueprint: null };
    }
    em.emit('run.failed', 'discovery', 'Run failed', { correlationId: 'run', status: 'failed' });
    yield* drain();
    return { ...base, phase: 'error', stage: 'error', reply: `${parsed.error} You can retry.`, brief, session };
  }

  // ===================================================================
  // THE DISCOVERY GATE.
  //
  // Previously this read `parsed.value.action === 'ask'` — i.e. the MODEL
  // decided whether discovery was finished, and a model that opened with
  // "propose" skipped it entirely. The application now forms its own view
  // from the accumulated brief, and can override a premature proposal.
  // ===================================================================
  // Record what the agent says it considered BEFORE the gate reads the brief,
  // so a turn's own findings count towards that turn's decision. Merging is
  // additive: a round that discusses timing cannot erase what an earlier round
  // established about the audience.
  if (parsed.value.dimensions?.length) {
    brief = recordDimensions(brief, parsed.value.dimensions);
  }
  // The two customer findings, recorded before the gate for the same reason.
  //
  // `recordBarriers` verifies each barrier's claimed quote against what the
  // manager actually typed and downgrades the basis when it does not match,
  // so a reason the agent invented and credited to them cannot be designed
  // against. That check belongs here, at the boundary where model output
  // becomes application state, rather than anywhere it could be bypassed.
  if (parsed.value.converters) {
    brief = recordConverters(brief, parsed.value.converters);
  }
  if (parsed.value.barriers?.length) {
    brief = recordBarriers(brief, parsed.value.barriers);
  }
  // Which of the outstanding questions the latest reply did NOT cover.
  //
  // Applied UNCONDITIONALLY, and that is the whole point. The field used to be
  // the positive "answered", set only when present, so a model that simply
  // forgot to emit it caused the application to tell a campaign manager their
  // clear answer did not count and then ask the same question again. A reply
  // that answers is the common case; it must not depend on a field arriving.
  if (parsed.value.answered?.length) {
    brief = recordAddressedQuestions(brief, parsed.value.answered);
  }
  brief = recordUncoveredQuestions(brief, parsed.value.notCovered);
  if (parsed.value.questionResolutions?.length) {
    brief = recordQuestionResolutions(brief, parsed.value.questionResolutions);
  }
  // What the agent says it consulted, kept as a record rather than prose.
  if (parsed.value.contextChecked?.length) {
    brief = recordContextChecked(brief, parsed.value.contextChecked);
  }
  // Settled on the propose turn, so the gate can tell a strategy that knows
  // what success means from one that never asked.
  if (parsed.value.action === 'propose' && parsed.value.strategy?.successCriteria?.length) {
    brief = recordSuccessCriteria(brief, parsed.value.strategy.successCriteria);
  }

  const proposed = parsed.value.action === 'propose' ? parsed.value : null;

  // Open items the APPLICATION raises, from metadata rather than from the
  // model's judgement: a value the user stated that the platform cannot hold,
  // and any event category the platform itself marks as not yet built.
  const appOpenItems: OpenItem[] = [
    ...unresolvedConflicts(brief.statedValues ?? []).map((c) => ({
      kind: 'strategic-ambiguity' as const,
      question: `${c.explanation} Which of those do you mean?`,
      whyItMatters:
        'The campaign cannot carry that value as stated, and choosing a different attribute on your behalf would change who it targets.',
    })),
    ...unverifiedCapabilities(proposed?.blueprint ?? null),
  ];

  // A proposal built on the user's own explanation of customer behaviour must
  // say that it is a hypothesis somewhere the user will see. Not a style rule:
  // a strategy that designs for one reading of a stated cause, and nowhere
  // records that other readings exist, has quietly converted their guess into
  // the finding the campaign rests on.
  //
  // Checked here rather than in the gate because it needs the STRATEGY, which
  // the gate does not receive. Loop-safe by construction — the model satisfies
  // it by writing one hypothesis or by asking the question instead, and both
  // end the condition — so it can never hold a conversation open the way a
  // round count would.
  // A question that was asked, drew a reply that did not answer it, and that
  // the proposal then says nothing about anywhere. The user asked for a design
  // and the agent never found out something it had itself decided it needed.
  //
  // Same shape as the belief guard below and loop-safe for the same reason:
  // the model ends the condition by asking the question again, or by naming
  // what it is assuming instead. Both are one turn away and always available.
  // Risk-weighted, and question-specific. A fork the agent itself flagged
  // cannot be discharged at all; anything else needs a reason naming its id.
  // The old guard accepted ANY assumption anywhere in the strategy as
  // discharging EVERY outstanding question, which is how the biggest fork in
  // the OS-to-EMI conversation was settled by inference.
  const openForks = unansweredForks(brief);
  const pendingQuestions = unresolvedQuestions(brief);

  const beliefsInPlay = briefDimensions(brief).filter((d) => d.basis === 'user-belief');
  const strategyNamesAHypothesis = Boolean(
    proposed?.strategy?.hypotheses?.length ||
      proposed?.strategy?.unknowns?.length ||
      proposed?.openItems?.some((i) => i.kind === 'strategic-ambiguity'),
  );
  //
  // ALL FOUR YIELD AT THE BUDGET, and that is the fix for an unbounded loop.
  // `evaluateDiscovery` already escapes at the round limit by returning
  // `ready_for_strategy`, but these four vetoes are computed out here and the
  // branch below ORs them with the gate's outcome — so a refusal survived the
  // escape hatch and regenerated for ever. Measured: the same refusal three
  // turns running, with the user answering each time and finally giving up.
  // A spent budget now means the agent proceeds and states what it assumed,
  // which is the standing instruction: with no facts, take a strong guess and
  // say it is a guess. It must never mean the conversation cannot end.
  const beliefUntreated = !limitReached && beliefsInPlay.length > 0 && proposed !== null && !strategyNamesAHypothesis;
  const forkUnanswered = !limitReached && openForks.length > 0 && proposed !== null;
  // A dimension the agent raised and never resolved may not reach a proposal.
  // See `unresolvedDimensions` for the measured defect this closes.
  const openDims = unresolvedDimensions(brief);
  const dimensionUnresolved = !limitReached && openDims.length > 0 && proposed !== null;
  const questionDropped = !limitReached && pendingQuestions.length > 0 && proposed !== null;

  // THE DEFECT THIS FIXES: every recordQuestions call below passes
  // `gate.questions`, which are plain strings — `asQuestion()` builds them, and
  // GateInput.modelQuestions is typed string[]. So the model's "impact" was
  // parsed, handed to the gate, and dropped on the floor before it reached the
  // brief. `unansweredForks` was therefore empty on every turn of every run,
  // and the fork guard could not fire. The prompt was never the problem.
  //
  // Matching is by exact question text, which is safe here because these ARE
  // the model's own strings on the path that carries an impact: the gate
  // echoes them back unchanged.
  const impactByText = new Map<string, ReturnType<typeof asImpact>>();
  // The contingency travels the SAME path as the impact, for the same reason.
  // Adding a second field to the question payload and plumbing it separately
  // is how `impact` came to be parsed and then discarded; there is one map per
  // field but one re-attachment point for both.
  const contingencyByText = new Map<string, ReturnType<typeof asContingency>>();
  if (parsed.value.action === 'ask') {
    for (const q of parsed.value.questions ?? []) {
      if (typeof q !== 'string') {
        impactByText.set(q.text, asImpact(q.impact));
        contingencyByText.set(q.text, asContingency((q as { contingency?: unknown }).contingency));
      }
    }
  }
  /** Re-attaches what the model declared about each question, where it did. */
  const withImpact = (questions: string[]) =>
    questions.map((text) => {
      const impact = impactByText.get(text);
      const contingency = contingencyByText.get(text);
      return impact || contingency ? { text, ...(impact ? { impact } : {}), ...(contingency ? { contingency } : {}) } : text;
    });

  const gate = evaluateDiscovery({
    appOpenItems,
    brief,
    modelAction:
      parsed.value.action === 'ask' ? 'ask' : parsed.value.action === 'request_evidence' ? 'request_evidence' : 'propose',
    modelQuestions:
      parsed.value.action === 'ask'
        ? (parsed.value.questions ?? []).map((q) => (typeof q === 'string' ? q : q.text))
        : [],
    modelEvidence: parsed.value.action === 'request_evidence' ? (parsed.value.evidence ?? []) : [],
    openItems: proposed?.openItems ?? [],
    // Read only if the model still emits the old shape.
    declaredUnknowns: proposed?.strategy?.unknowns ?? [],
    forced: limitReached,
    maxRounds: MAX_DISCOVERY_ROUNDS,
    isRefinement,
  });

  if (gate.outcome === 'request_evidence') {
    brief = recordEvidenceRequests(brief, gate.evidence);
    session = {
      ...session,
      state: transition(
        session.state === 'DISCOVERING' ? session.state : transition(session.state, 'DISCOVERING'),
        'AWAITING_USER_ANSWER',
      ),
    };
    em.emit('discovery.questions', 'discovery', `Asked for ${gate.evidence.length} piece(s) of data`, {
      detail: 'This is a request for aggregated data, not a prerequisite — you can say it is unavailable and the agent will proceed.',
      data: { evidence: gate.evidence, round: brief.rounds },
    });
    em.emit('run.completed', 'discovery', 'Waiting for your data or a reply that it is unavailable', { correlationId: 'run' });
    yield* drain();
    return {
      ...base,
      phase: 'discovery',
      stage: 'discovery',
      reply:
        (parsed.value.action === 'request_evidence' ? parsed.value.rationale : undefined) ??
        'Some aggregated data would materially improve this design.',
      questions: [],
      evidenceRequests: gate.evidence,
      discoveryRounds: brief.rounds,
      discoveryLimitReached: brief.rounds >= MAX_DISCOVERY_ROUNDS,
      brief,
      session,
      discoveryReason: gate.reason,
      usage,
    };
  }

  if (gate.outcome === 'ask_questions') {
    brief = recordQuestions(brief, withImpact(gate.questions));
    // Always route through DISCOVERING: both UNDERSTANDING_GOAL (the first
    // turn) and AWAITING_USER_ANSWER (a follow-up round) reach the question
    // state that way, and neither may jump there directly.
    session = {
      ...session,
      state: transition(
        session.state === 'DISCOVERING' ? session.state : transition(session.state, 'DISCOVERING'),
        'AWAITING_USER_ANSWER',
      ),
    };
    em.emit('discovery.questions', 'discovery', `Asked ${gate.questions.length} question${gate.questions.length === 1 ? '' : 's'}`, {
      detail: gate.overrodeModel ? 'The agent proposed early, so its own open unknowns were put to you first.' : gate.reason,
      data: { questions: gate.questions, reason: gate.reason, overrodeModel: gate.overrodeModel, round: brief.rounds },
    });
    em.emit('run.completed', 'discovery', 'Waiting for your answer', { correlationId: 'run' });
    yield* drain();
    return {
      ...base,
      phase: 'discovery',
      stage: 'discovery',
      reply:
        (parsed.value.action === 'ask' ? parsed.value.rationale : gate.reason) ??
        'A few questions before I design this.',
      questions: gate.questions,
      discoveryRounds: brief.rounds,
      discoveryLimitReached: brief.rounds >= MAX_DISCOVERY_ROUNDS,
      brief,
      session,
      discoveryReason: gate.reason,
      usage,
    };
  }

  // DISCOVERY FIRST, enforced here and not only in the prompt.
  //
  // This branch has to exist for the gate's decision to mean anything: the
  // outcomes below are if-chains with early returns, so an unhandled outcome
  // would fall straight through and return the strategy the gate had just
  // refused. Nothing is proposed, so there is nothing for the user to confirm
  // and no blueprint for the approval gate to be handed.
  if (gate.outcome === 'continue_discovery' || beliefUntreated || questionDropped || forkUnanswered || dimensionUnresolved) {
    brief = recordQuestions(brief, withImpact(gate.questions));
    // Count this refusal against each fork that caused it, so the next one
    // escalates and then falls back instead of repeating a third time.
    if (forkUnanswered) brief = recordForkRefusal(brief, openForks.map((q) => q.id));
    session = {
      ...session,
      state: transition(
        session.state === 'DISCOVERING' ? session.state : transition(session.state, 'DISCOVERING'),
        'AWAITING_USER_ANSWER',
      ),
    };
    const open = outstandingDimensions(brief);
    em.emit('discovery.questions', 'discovery', 'Discovery continues', {
      detail: gate.reason,
      data: {
        reason: gate.reason,
        overrodeModel: gate.overrodeModel,
        questions: gate.questions,
        // Names and statuses only. No strategy and no blueprint leave this
        // branch, so nothing the gate refused can reach the client.
        openDimensions: open.map((d) => ({ name: d.name, status: d.status })),
        round: brief.rounds,
      },
    });
    em.emit('run.completed', 'discovery', 'Waiting for your answer', { correlationId: 'run' });
    yield* drain();

    // A refusal the user cannot act on is a dead end, and the gate cannot
    // make the model ask a question. So the record travels with the reason:
    // the names and rationales are the AGENT's own words, which keeps
    // question authorship where it belongs while still giving the user
    // something concrete to correct. Caught by a real e2e failure, where a
    // refused turn rendered neither a question nor a confirmation gate.
    const recorded = briefDimensions(brief);
    const reply = [
      forkUnanswered
        // Second time of asking reads differently from the first, and always
        // names what will happen if no answer comes. Regenerating one sentence
        // forever is what the previous version did, twice, verbatim.
        ? openForks
            .map((q) => {
              const again = (q.blockedCount ?? 0) >= 1;
              const fallback = q.contingency?.ifUnknown;
              return [
                again
                  ? `One more on this, then I will decide and tell you what I assumed: "${q.text}"`
                  : `Before I design anything I need this one settled, because it changes which campaign this is rather than how it is built: "${q.text}"`,
                fallback
                  ? `If you would rather not answer, say so and ${/^i\s+will\b/i.test(fallback.trim()) ? `${fallback.charAt(0).toLowerCase()}${fallback.slice(1)}` : `I will ${fallback.charAt(0).toLowerCase()}${fallback.slice(1)}`}`
                  : 'If you cannot answer it, tell me and I will carry it as an open decision for you to settle before launch rather than quietly choosing.',
              ].join(' ');
            })
            .join('\n\n')
        : questionDropped
        ? `I asked ${pendingQuestions.map((q) => `"${q.text}"`).join(' and ')}, and your reply did not cover it. I was about to design around that without telling you what I had assumed. Let me either ask it again or state the assumption plainly.`
        : dimensionUnresolved
        ? `I raised ${openDims.map((d) => `"${d.name}"`).join(' and ')} as something that could change this campaign, and then never actually looked into ${openDims.length === 1 ? 'it' : 'them'}. I was about to design as though ${openDims.length === 1 ? 'it did not matter' : 'they did not matter'}, which is not the same as having checked. Let me either ask you, or tell you plainly what I am assuming and why.`
        : beliefUntreated
        ? `This design rests on ${beliefsInPlay.map((d) => `"${d.name}"`).join(' and ')}, which you offered as your own reading rather than something measured. I have not said anywhere that it is untested, and competing explanations may change the campaign. Let me either ask what would separate them or carry them as stated hypotheses.`
        : gate.reason,
      recorded.length ? '\nWhat I am working through:' : '',
      // Plain words, not the status enum. `retained | deferred | unavailable`
      // is the application's vocabulary for its own record; printing it to a
      // campaign manager asks them to learn our data model to read their own
      // conversation. "(retained)" tells them nothing — it is
      // the ordinary case.
      ...recorded.map((d) => {
        const where =
          d.status === 'open'
            ? ' — still looking into this'
            : d.status === 'deferred'
              ? ' — set aside'
              : d.status === 'unavailable'
                ? ' — nothing available to settle this'
                : '';
        return `- ${d.name}${where}${d.rationale ? `: ${d.rationale}` : ''}`;
      }),
      recorded.length ? '\nCorrect anything that is wrong here, or tell me to go ahead anyway.' : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      ...base,
      phase: 'discovery',
      stage: 'discovery',
      reply,
      questions: gate.questions,
      strategy: null,
      blueprint: null,
      pendingBlueprint: null,
      discoveryRounds: brief.rounds,
      discoveryLimitReached: brief.rounds >= MAX_DISCOVERY_ROUNDS,
      brief,
      session,
      discoveryReason: gate.reason,
      usage,
    };
  }

  // Discovery is complete. If the model only asked questions, it has nothing
  // to propose — that is a real failure, not something to paper over.
  if (!proposed) {
    em.emit('run.failed', 'strategy', 'No strategy produced', { correlationId: 'run',
      status: 'failed',
      detail: 'Discovery is complete but the agent returned questions instead of a strategy.',
    });
    yield* drain();
    return {
      ...base,
      phase: 'error',
      stage: 'error',
      reply: 'The agent did not produce a strategy. Retry to force a proposal.',
      brief,
      session,
    };
  }

  const { blueprint } = proposed;
  // RULE 2.4. Verify every `used` option against the journey actually
  // proposed, and downgrade the ones it does not support. The application
  // never rewrites the journey and never invents a capability — it reads the
  // blueprint and declines to repeat a claim the blueprint contradicts.
  const optionAudits: OptionAudit[] = auditOptions(proposed.strategy?.strategyOptions, blueprint);
  // Whether the alternatives it weighed are actually different campaigns, and
  // whether the winner it declared is the one that got built. Both are set by
  // the application, never by the model, and both can only ever downgrade a
  // claim — see `server/architectureAudit.ts` for why one of them is a hard
  // check and the other is only a floor.
  const architectureComparison = compareArchitectures(proposed.strategy?.architectures);
  const fidelity = checkFidelity(proposed.strategy?.architectures, blueprint);
  // An experiment whose arms run the same journey can test wording and nothing
  // more. Folded into the comparison verdict rather than given its own field:
  // it is the same finding — alternatives that are not really alternatives.
  const copyOnly = copyOnlyExperiments(blueprint);
  const strategy = proposed.strategy
    ? {
        ...proposed.strategy,
        strategyOptions: applyAudit(proposed.strategy.strategyOptions, optionAudits),
        // Two findings, two fields, deliberately.
        //
        // These were folded into one status, and the output contradicted
        // itself in consecutive sentences: "These were not materially
        // different approaches. 2 candidates differ in who they reach, when,
        // or what the journey does." Both halves were true of DIFFERENT
        // questions — the candidates really did differ, and separately the
        // experiment inside the winner could not discriminate. Collapsing
        // them made the verdict unreadable.
        architectureComparison,
        designWarnings: [
          fidelity && !fidelity.ok ? fidelity.why : '',
          copyOnly.length
            ? `The experiment ${copyOnly.map((e) => `"${e.label}" (arms ${e.arms.join(' / ')})`).join('; ')} runs the same journey in every arm. It can show which wording performs better. It cannot show which customer barrier was real, so this campaign cannot settle that question.`
            : '',
        ].filter(Boolean),
      }
    : proposed.strategy;
  // A PROPOSE TURN CARRIES NO BLUEPRINT, BY DESIGN.
  //
  // The plan is agreed in business terms first and mapped to the builder only
  // after the manager approves it — see the standing principle in
  // server/CLAUDE.md. So there is nothing to build here, nothing to validate,
  // and no graph to show: the deliverable is the strategy itself.
  //
  // The structural checks that read a journey (barrier coverage, whether the
  // campaign can learn who converts, whether an experiment can settle its own
  // claim) move to the build turn with it. They check what was BUILT, and on
  // this turn nothing has been.
  if (!isBuildTurn) {
    em.emit('strategy.proposed', 'strategy', 'Strategy ready', { detail: strategy?.summary?.slice(0, 160) });
    em.emit('run.completed', 'strategy', 'Waiting for your approval', { correlationId: 'run' });
    yield* drain();
    return {
      ...base,
      phase: 'awaiting-confirmation',
      stage: 'proposed',
      reply: renderStrategy(
        strategy,
        gate.openItems,
        undefined,
        brief.questionResolutions ?? [],
        brief.questions,
        unsupportedClaims(optionAudits),
      ),
      strategy,
      blueprint: null,
      pendingBlueprint: null,
      questions: gate.questions,
      discoveryRounds: brief.rounds,
      discoveryLimitReached: brief.rounds >= MAX_DISCOVERY_ROUNDS,
      brief,
      session,
      discoveryReason: gate.reason,
      usage,
    };
  }

  if (!blueprint?.entry || !Array.isArray(blueprint.steps)) {
    em.emit('run.failed', 'strategy', 'Incomplete strategy', { correlationId: 'run', status: 'failed' });
    yield* drain();
    return { ...base, phase: 'error', stage: 'error', reply: 'The agent returned an incomplete plan. You can retry.', strategy, brief, session };
  }

  // A refinement means a campaign already exists and the user has asked for a
  // specific change — that IS the confirmation, so build it now.
  if (isRefinement) {
    // A refinement of an existing campaign IS the user's confirmation: they
    // asked for a specific change to something already on the canvas.
    em.emit('strategy.proposed', 'generating', 'Change understood', { detail: strategy?.summary?.slice(0, 160) });
    yield* drain();
    const out = buildAndValidate(req, tenant, bank, availableChannels, blueprint, strategy, em);
    yield* drain();
    session = {
      ...session,
      state: out.exportable ? 'EXPORT_ELIGIBLE' : 'CONFIGURATION_INCOMPLETE',
      strategyVersion: session.strategyVersion + 1,
      confirmation: {
        objectiveFingerprint: brief.objectiveFingerprint,
        strategyVersion: session.strategyVersion + 1,
        confirmedAt: new Date().toISOString(),
      },
    };
    return { ...base, ...out, phase: out.stage === 'error' ? 'error' : 'review', brief, session, usage };
  }

  // Otherwise: STOP here. The strategy is proposed and awaits confirmation.
  //
  // Open questions travel WITH it. They used to replace it: a material open
  // item sent the turn down the ask_questions path, which returns before this
  // point with strategy and blueprint still null, so a complete
  // recommendation was destroyed for having an honest open item — while the
  // prompt was asking the model to declare exactly those items.
  const withQuestions = gate.outcome === 'strategy_with_questions';
  if (withQuestions) brief = recordQuestions(brief, withImpact(gate.questions));

  em.emit('strategy.proposed', 'strategy', 'Strategy ready for your review', {
    detail: withQuestions
      ? 'Nothing has been built yet. Some points are still open; answer them or confirm as it stands.'
      : 'Nothing has been built yet — confirm to generate the campaign.',
    data: {
      summary: strategy?.summary,
      steps: blueprint.steps.length,
      openItems: gate.openItems,
      questions: gate.questions,
    },
  });
  if (withQuestions) {
    em.emit('discovery.questions', 'strategy', `${gate.questions.length} open question(s) alongside the strategy`, {
      detail: gate.reason,
      data: { questions: gate.questions, round: brief.rounds },
    });
  }
  em.emit('run.completed', 'strategy', withQuestions ? 'Waiting for your answer or confirmation' : 'Waiting for your confirmation', { correlationId: 'run' });
  yield* drain();

  // A new strategy is a new version, so a confirmation of the previous one
  // cannot authorise building this.
  // UNDERSTANDING_GOAL / AWAITING_USER_ANSWER -> STRATEGY_READY ->
  // AWAITING_STRATEGY_CONFIRMATION, so every legal hop is taken explicitly.
  const toStrategyReady = transition(
    session.state === 'STRATEGY_READY' ? 'DISCOVERING' : session.state,
    'STRATEGY_READY',
  );
  session = {
    ...session,
    state: transition(toStrategyReady, 'AWAITING_STRATEGY_CONFIRMATION'),
    strategyVersion: session.strategyVersion + 1,
    confirmation: null,
  };

  // REFUSE AN EXPERIMENT THAT CANNOT SETTLE WHAT IT CLAIMS.
  //
  // Not a warning this time. MEASURED: across three proposals in one
  // conversation the agent built arms that were the identical journey, said it
  // was testing which customer barrier was real, was told so underneath its
  // own strategy, and answered by renaming the experiment and rebuilding the
  // same thing. Being told is demonstrably not enough; this is the fork
  // guard's discipline applied where the defect actually lives.
  //
  // It cannot trap: declaring the experiment as a wording test is always
  // available, always legal, and is an honest description of what was built.
  // A guard with no legal move is a trap, and this one always has two.
  // A campaign for customers nobody can characterise has to separate them and
  // compare. Refused the same way and for the same reason as an experiment
  // whose arms cannot answer its own question: the design does not do the job
  // the situation requires, and that is a fact about the built journey rather
  // than a matter of taste.
  // Every message attacks a stated reason, and every stated reason is
  // attacked. Checked against the built journey, because a prompt asking the
  // agent to "address the barriers" is exactly the kind of instruction that
  // reads as satisfied by a summary paragraph while the steps do nothing.
  const coverage = checkBarrierCoverage(blueprint, mustBeAddressed(brief.barriers));
  if (coverage.uncitedSends.length || coverage.unaddressed.length) {
    const why = [
      ...coverage.unaddressed.map(
        (b) =>
          `You told me: ${b.statement} Nothing in this campaign does anything about it, so building it would leave the reason you gave untouched.`,
      ),
      ...(coverage.uncitedSends.length
        ? [
            `These messages do not say which problem they solve: ${coverage.uncitedSends.join(', ')}. A message that is not answering a known reason is just another contact.`,
          ]
        : []),
    ];
    brief = recordApplicationVerdict(brief, { warnings: why });
    session = { ...session, state: transition(session.state === 'DISCOVERING' ? session.state : transition(session.state, 'DISCOVERING'), 'AWAITING_USER_ANSWER') };
    em.emit('validation.started', 'strategy', 'The campaign does not address what we learned', {
      status: 'failed',
      detail: `${coverage.unaddressed.length} reason(s) unaddressed, ${coverage.uncitedSends.length} message(s) with no stated purpose`,
      data: { coverage },
    });
    em.emit('run.completed', 'discovery', 'Reworking the campaign', { correlationId: 'run' });
    yield* drain();
    return {
      ...base,
      phase: 'discovery',
      stage: 'discovery',
      reply: ['I need to rework this before showing it to you.', '', ...why].join('\n'),
      questions: [],
      brief,
      session,
      strategy: null,
      blueprint: null,
    };
  }

  // Same obligation, applied to the reasons rather than the audience: a
  // campaign resting entirely on the agent's own reading has to find out
  // whether that reading was right.
  const untestedGuess = checkBarrierTesting(blueprint, mustTestBarriers(brief.barriers));
  const audienceGap = checkAudienceLearning(blueprint, mustLearnAudience(brief.converters)) ?? untestedGuess;
  if (audienceGap) {
    brief = recordApplicationVerdict(brief, { warnings: [audienceGap] });
    session = { ...session, state: transition(session.state === 'DISCOVERING' ? session.state : transition(session.state, 'DISCOVERING'), 'AWAITING_USER_ANSWER') };
    em.emit('validation.started', 'strategy', 'The campaign cannot learn who converts', {
      status: 'failed',
      detail: 'Nobody could say who converts, and the journey treats everyone the same.',
    });
    em.emit('run.completed', 'discovery', 'Reworking the audience', { correlationId: 'run' });
    yield* drain();
    return {
      ...base,
      phase: 'discovery',
      stage: 'discovery',
      reply: ['I need to rework one thing before showing you this.', '', audienceGap].join('\n'),
      questions: ['Which groups should this campaign treat differently, so we can see who actually converts?'],
      brief,
      session,
      strategy: null,
      blueprint: null,
    };
  }

  const claimViolations = checkExperimentClaims(blueprint);
  if (claimViolations.length) {
    brief = recordApplicationVerdict(brief, {
      warnings: claimViolations.map((v) => v.why),
    });
    session = { ...session, state: transition(session.state === 'DISCOVERING' ? session.state : transition(session.state, 'DISCOVERING'), 'AWAITING_USER_ANSWER') };
    em.emit('validation.started', 'strategy', 'Experiment cannot answer its own question', {
      status: 'failed',
      detail: claimViolations.map((v) => v.label).join('; '),
      data: { violations: claimViolations },
    });
    em.emit('run.completed', 'discovery', 'Reworking the experiment', { correlationId: 'run' });
    yield* drain();
    return {
      ...base,
      phase: 'discovery',
      stage: 'discovery',
      reply: [
        'I need to rework one thing before showing you this.',
        '',
        ...claimViolations.map((v) => v.why),
        '',
        'Two honest ways forward, and I would rather you chose: either the arms become genuinely different campaigns — reaching different people, or at a different moment, or doing different things — so the result actually tells us why customers behave as they do. Or we keep it as a straightforward test of which message works better, and accept that it will not explain the reason behind it.',
        'Tell me which you want, or say go ahead and I will treat it as a message test.',
      ].join('\n'),
      questions: ['Should the experiment be rebuilt so it can explain WHY customers do not convert, or kept as a simpler test of which message works better?'],
      discoveryRounds: brief.rounds,
      brief,
      session,
      discoveryReason: 'experiment cannot settle what it claims',
      usage,
    };
  }

  const readiness = assessGraphReadiness(blueprint, tenant, availableChannels);
  // Record what the application concluded, so the NEXT turn's brief carries it.
  // Without this the agent cannot see its own verdicts and will re-propose a
  // design the application has already rejected — measured three times running
  // on one live run.
  // What the agent asked for versus what the platform could give it.
  //
  // The point of the design step is that this gap belongs to the application,
  // computed from real metadata before any blueprint existed — so it cannot be
  // quietly absorbed into the campaign that got built. It goes in front of the
  // user, in their own requirement's words.
  const gapSection = (() => {
    const missing = capabilityGaps(designVerdicts);
    if (!missing.length) return '';
    const line = (v: RequirementVerdict) =>
      `- You asked for: ${v.need}\n  ${v.detail}`;
    return `\n\n**What you asked for that this platform cannot do**\n${missing.map(line).join('\n')}\n\nThe campaign below works around these rather than meeting them. If any of them matters more than what was built, say so and it changes the design.`;
  })();

  // The campaign goes first, above every word of reasoning about it. It was
  // previously never shown at all: the reader had to reconstruct the journey
  // from "Timing:", "Why it should work:" and the approach bullets.
  const campaignSummary = journeySummary(blueprint);

  const replyText = renderStrategy(
    strategy, gate.openItems, readiness, brief.questionResolutions ?? [], brief.questions, unsupportedClaims(optionAudits),
  ).replace(/^/, campaignSummary ? campaignSummary.trim() + '\n\n' : '') + gapSection;
  brief = recordApplicationVerdict(brief, {
    comparison: strategy?.architectureComparison,
    warnings: [...(strategy?.designWarnings ?? []), ...jargonNotes(replyText)],
    blockers: readiness.status === 'blocked' ? readiness.blockers : [],
  });
  if (readiness.status === 'blocked') {
    em.emit('validation.started', 'strategy', 'Configuration not yet buildable', {
      status: 'failed',
      detail: readiness.blockers.join(' '),
      data: { blockers: readiness.blockers },
    });
    yield* drain();
  }

  // A BUILD TURN BUILDS. It does not ask again.
  //
  // THE BUG THIS FIXES: the propose path now returns `pendingBlueprint: null`,
  // so the client sends `confirmedBlueprint: null` when the user approves.
  // That misses the confirm short-circuit at the top of this function, lands
  // here with `isBuildTurn` true, produces a blueprint — and returned
  // `awaiting-confirmation` with the SAME copy the user had just answered.
  // They had to press "Confirm and generate" twice, with no indication that
  // the first press had done anything. Every test supplies
  // `confirmedBlueprint` directly, so none of them walked the path the app
  // actually takes.
  if (isBuildTurn) {
    const out = buildAndValidate(req, tenant, bank, availableChannels, blueprint, strategy, em);
    // Resolve the row opened by run.started. Without this the build turn
    // returns with that spinner still turning, because every other exit from
    // this function emits one and this path was added later.
    em.emit('run.completed', 'generating', out.exportable ? 'Campaign built' : 'Campaign built, with configuration still needed', {
      correlationId: 'run',
    });
    yield* drain();
    session = {
      ...session,
      state: transition(session.state, out.exportable ? 'EXPORT_ELIGIBLE' : 'CONFIGURATION_INCOMPLETE'),
      confirmation: {
        objectiveFingerprint: brief.objectiveFingerprint,
        strategyVersion: session.strategyVersion,
        confirmedAt: new Date().toISOString(),
      },
    };
    return { ...base, ...out, phase: out.stage === 'error' ? 'error' : 'review', brief, session, usage };
  }

  return {
    ...base,
    phase: 'awaiting-confirmation',
    stage: 'proposed',
    reply: replyText,
    graphReadiness: readiness,
    strategy,
    blueprint,
    pendingBlueprint: blueprint,
    questions: gate.questions,
    discoveryRounds: brief.rounds,
    discoveryLimitReached: brief.rounds >= MAX_DISCOVERY_ROUNDS,
    brief,
    session,
    discoveryReason: gate.reason,
    usage,
  };
}

/**
 * Event categories this blueprint relies on that the platform marks as new.
 *
 * `isNew` means "proposed, not confirmed built in production" — the builder
 * shows it as "(New)" to a person configuring a node by hand. The agent was
 * never told, so an entire EMI campaign could be designed on a trigger that
 * may not exist yet and presented as though it were verified. Raised during
 * the STRATEGY phase, which is the last point where changing course is cheap.
 */
function unverifiedCapabilities(bp: CampaignBlueprint | null): OpenItem[] {
  if (!bp) return [];
  const categories = new Set<string>();
  if (bp.entry?.kind === 'event') categories.add(bp.entry.eventCategory);
  if (bp.goal?.eventCategory) categories.add(bp.goal.eventCategory);
  const walk = (steps: CampaignBlueprint['steps']) => {
    for (const s of steps ?? []) {
      if (s.kind === 'waitForEvent') categories.add(s.eventCategory);
      if (s.kind === 'experiment') for (const a of s.arms ?? []) walk(a.steps);
      if (s.kind === 'condition') {
        walk(s.yes);
        walk(s.no);
      }
    }
  };
  walk(bp.steps);
  return [...categories]
    .filter((c) => eventConditionTarget(c).isNew)
    .map((c) => ({
      kind: 'operational-limitation' as const,
      question: `${c} is marked new in the platform metadata: proposed, not confirmed as built in production.`,
      whyItMatters: 'This campaign depends on it, so it cannot be presented as a verified platform capability.',
    }));
}

/**
 * Would this blueprint build? Answered at STRATEGY time, before anything is
 * constructed, so "you approved the approach" is never mistaken for "the
 * campaign can be generated".
 */
function assessGraphReadiness(
  bp: CampaignBlueprint,
  tenant: TenantConfig,
  availableChannels: Channel[],
): { status: 'ready' | 'blocked'; blockers: string[]; limitations: string[] } {
  const dry = buildFromBlueprint(bp, {
    availableChannels,
    templateLibraryAccess: tenant.templateLibraryAccess,
  });
  const blockers = dry.issues.map((i) => `${i.path}: ${i.problem}`);
  return {
    status: blockers.length ? 'blocked' : 'ready',
    blockers,
    limitations: dry.limitations.map((l) => l.note),
  };
}

/** Builds the graph and validates it. Only ever called after confirmation. */
function buildAndValidate(
  req: OrchestratorRequest,
  tenant: TenantConfig,
  bank: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  availableChannels: Channel[],
  blueprint: CampaignBlueprint,
  strategy: Strategy | null,
  em: EventEmitterSeq,
): Partial<OrchestratorResponse> & { stage: Stage } {
  const started = Date.now();
  em.emit('graph.generation.started', 'generating', 'Building the journey', {
    status: 'running',
    detail: `${blueprint.steps.length} planned step(s)`,
  });

  const built = buildFromBlueprint(blueprint, {
    availableChannels,
    templateLibraryAccess: tenant.templateLibraryAccess,
    resolvedSends: req.resolvedSends,
  });

  // Reported from the graph that was actually produced, not from the plan.
  const counts = Object.values(built.graph.nodes).reduce<Record<string, number>>((acc, n) => {
    acc[n.type] = (acc[n.type] ?? 0) + 1;
    return acc;
  }, {});
  for (const [type, n] of Object.entries(counts)) {
    em.emit('graph.step.created', 'generating', `${n} × ${DC_NODE_META[type as keyof typeof DC_NODE_META]?.type ?? type}`, {
      data: { type, count: n },
    });
  }
  em.emit('graph.generation.completed', 'generating', 'Journey built', {
    durationMs: Date.now() - started,
    detail: `${Object.keys(built.graph.nodes).length} steps, ${built.graph.edges.length} connections`,
    data: { issues: built.issues, templateChoices: built.templateChoices },
  });

  const proposal = buildCampaignProposal({
    scenarioId: req.sessionId,
    goalStatement: [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '',
    goal: built.goal,
    graph: built.graph,
    tenantContext: { tenantId: tenant.tenantId, issuer: tenant.issuer },
  });
  const campaign =
    proposal.usable && blueprint.campaignName
      ? { ...proposal.campaign, name: blueprint.campaignName, description: blueprint.description ?? proposal.campaign.description }
      : proposal.campaign;

  em.emit('validation.started', 'validating', 'Checking the campaign', { status: 'running' });
  const validation = validateCampaignGraph(
    built.graph,
    { fanOut: [] },
    {
      // No per-campaign message cap is supplied, deliberately. It is not an
      // issuer policy — how many messages a campaign sends differs per
      // campaign — and supplying a number made the agent treat it as a budget
      // to stay under rather than a design decision to justify. The validator
      // already skips this check when no cap is given.
      quietHours: bank.hardConstraints.quietHours,
      availableChannels: bank.channels.available,
    },
    { campaign, provenance: proposal.provenance, blockers: proposal.blockers as string[] },
  );
  const outcomeWords =
    validation.outcome === 'failed'
      ? 'Blocked — required information is missing'
      : validation.outcome === 'incomplete'
        ? 'Passed, with checks a person must confirm before launch'
        : 'All checks passed';
  em.emit('validation.completed', 'validating', outcomeWords, {
    status: validation.outcome === 'failed' ? 'failed' : 'ok',
    data: {
      outcome: validation.outcome,
      checks: validation.checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
      unverifiedHardConstraints: validation.unverifiedHardConstraints,
    },
  });

  const structuralFailures = validation.checks.filter((c) => c.status === 'fail');
  const unresolvedSends = built.sendProposals.filter((p) => !p.accountResolved || !p.templateResolved);

  // THREE states, previously one.
  //
  // `exportable` used to require every Send to carry a real account and
  // template id. For a tenant whose template library Hyperface cannot read —
  // the realistic case — that is never true, so a complete, valid design
  // could not be downloaded at all, and the agent's own suggested messaging
  // could never leave the tool. Supplying the bank's ids is part of PREPARING
  // THE UPLOAD, not part of producing a design.
  const designGenerated = Boolean(built.graph.rootId) && built.issues.length === 0;

  // The app's own node-config rule fails a Send with no account or template
  // id. That rule is right for the manual builder's Submit gate and is left
  // exactly as it is in the validation report — but a field only the bank can
  // fill is not a defect in the DESIGN, so it must not block the download.
  //
  // Identified by asking the application's own validator twice rather than by
  // reading its message: invalid now, valid once the two bank fields are
  // populated. Any other kind of failure still blocks.
  const pendingBankIdsOnly = (nd: DripGraph['nodes'][string]) =>
    nd.type === 'SEND' &&
    !dcAddFormValid('SEND', nd._config ?? {}) &&
    dcAddFormValid('SEND', { ...(nd._config ?? {}), account: 'pending', templateId: 'pending' });
  const nodeConfigIsOnlyBankIds =
    Object.values(built.graph.nodes).filter((nd) => nd.type !== 'GOAL_CHECK' && !dcAddFormValid(nd.type, nd._config ?? {}))
      .every(pendingBankIdsOnly);
  const blockingFailures = structuralFailures.filter((c) => !(c.id === 'node-config' && nodeConfigIsOnlyBankIds));

  const exportable = designGenerated && blockingFailures.length === 0 && proposal.usable;

  // Import readiness is NOT computed, because there is nothing to compute it
  // against: the application has no JSON import path, so no contract exists
  // to verify (agent-proto/validate.ts, check 'app-import-accepts', which is
  // permanently 'not-run' for this reason). It is reported as unverified
  // rather than inferred from the JSON being well-formed.
  const outstandingForImport = [
    ...(unresolvedSends.length
      ? [`${unresolvedSends.length} message step(s) need the bank's real account and template ID.`]
      : []),
    ...proposal.unresolvedCampaignFields.map((f) => `Campaign field left for a person to decide: ${f}.`),
    ...validation.unverifiedHardConstraints.map((c) => `Hard constraint not verifiable here: ${c}.`),
    ...built.limitations.map((l) => l.note),
    ...unverifiedCapabilities(blueprint).map((i) => i.question),
  ];
  const importReadiness = {
    status: 'unverified' as const,
    reason:
      'The Drip Campaign application has no JSON import path, so no import contract exists to check this against. ' +
      'A valid design is not evidence that the platform would accept it.',
    outstanding: outstandingForImport,
  };

  em.emit('run.completed', 'review', exportable ? 'Design ready to export' : 'Campaign built — some details outstanding', { correlationId: 'run' });

  return {
    stage: proposal.usable ? 'proposed' : 'blocked',
    reply: renderBuildSummary(strategy, built, validation, unresolvedSends.length, exportable),
    strategy,
    blueprint,
    pendingBlueprint: null,
    campaign,
    graph: built.graph,
    provenance: proposal.provenance,
    unresolvedCampaignFields: proposal.unresolvedCampaignFields,
    campaignBlockers: proposal.blockers as string[],
    validation,
    buildIssues: built.issues,
    templateChoices: built.templateChoices,
    sendProposals: built.sendProposals,
    designGenerated,
    exportable,
    importReadiness,
    exportBlockedReason: exportable
      ? undefined
      : [
          !proposal.usable ? proposal.blockers.join(' ') : '',
          blockingFailures.length ? `Validation failed: ${blockingFailures.map((c) => c.id).join(', ')}.` : '',
          built.issues.length ? `The design could not be built: ${built.issues.map((i) => i.path).join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
  };
}

/**
 * The strategy, written for a person rather than dumped as JSON.
 *
 * This is also what the client stores as the assistant's turn, so everything
 * worth keeping has to be in here. Open items are grouped by what they
 * actually are, rather than flattened into one "Still unknown" list that read
 * the same whether the gap was a blocking definition or a nice-to-have.
 */
export function renderStrategy(
  s: Strategy | null,
  openItems: OpenItem[] = [],
  readiness?: { status: 'ready' | 'blocked'; blockers: string[]; limitations: string[] } | null,
  /**
   * Questions the agent decided to proceed WITHOUT an answer to, each with the
   * reason it gave. Rendered because the application holds them and the user
   * otherwise never sees them again.
   *
   * MEASURED, reproduced in both scenarios. A material targeting risk is raised
   * under "Worth settling before this is built" on the proposal turn. The user
   * replies without addressing it ("Looks good"). On the next turn the agent
   * records a `carried` or `deferred` resolution — honestly, and in one case
   * noting the item was "kept as a strategic-ambiguity open item rather than
   * quietly accepted as an operational limitation" — but stops re-emitting the
   * openItem, so that whole section vanishes from the reply. The decision the
   * user is being asked to confirm around reads as a footnote, or not at all.
   */
  carried: { questionId: string; kind: 'carried' | 'deferred'; why: string }[] = [],
  // Widened to the fields this function actually reads. It was narrowed to
  // id/text/addressedInRound while the body below used `impact`,
  // `blockedCount` and `contingency` — four type errors that nothing caught,
  // because this directory was never typechecked. Kept as optional members
  // rather than `OpenQuestion[]` so callers passing a minimal object still
  // compile.
  questions: {
    id: string;
    text: string;
    addressedInRound?: number;
    impact?: QuestionImpact;
    blockedCount?: number;
    contingency?: QuestionContingency;
  }[] = [],
  /** Claims the proposed journey did not bear out. RULE 2.4. */
  unsupported: { option: string; gap?: string }[] = [],
): string {
  if (!s) return 'Here is the strategy.';
  const part = (title: string, items?: string[]) =>
    items?.length ? `\n\n**${title}**\n${items.map((i) => `- ${i}`).join('\n')}` : '';

  const group = (kind: OpenItem['kind'], title: string, withFallback: boolean) => {
    const items = openItems.filter((i) => i.kind === kind);
    if (!items.length) return '';
    const lines = items.map((i) => {
      const why = i.whyItMatters ? ` ${i.whyItMatters}` : '';
      const fallback = withFallback && i.ifUnanswered ? ` Until then: ${i.ifUnanswered}` : '';
      return `- ${i.question}${why}${fallback}`;
    });
    return `\n\n**${title}**\n${lines.join('\n')}`;
  };

  // The verdicts read as a scan: what was weighed, and what came of each.
  // "used" items are already argued in Approach, so this section earns its
  // place on the ones that were set aside — but dropping those would hide
  // half the evaluation, so all of them are shown in the order given.
  const verdictWord = {
    'used': 'used',
    'not-applicable': 'not applicable here',
    'cannot-evaluate': 'cannot evaluate yet',
  } as const;
  const options = s.strategyOptions?.length
    ? `\n\n**Options weighed**\n${s.strategyOptions
        .map((o) => `- ${o.option} — ${verdictWord[o.verdict] ?? o.verdict}. ${o.why}`)
        .join('\n')}`
    : '';

  // RULE 2.1. The alternatives and why the winner won, before the detail of
  // the winner — a design is a choice, and the choice is the first thing worth
  // reading.
  const arch = s.architectures?.length
    ? `\n\n**Approaches considered**\n${s.architectures
        .map((a) => {
          // Read as prose, not as a form.
          //
          // These fields were added so the APPLICATION could check that two
          // candidates genuinely differ. Printing their field names to the
          // screen put 24 internal labels in front of a campaign manager —
          // "Barrier it addresses:", "Journey behaviour: experiment" — which
          // made the output read like a database row and was my doing, not the
          // model's. The same facts, written as sentences.
          const head = `- ${a.chosen ? `**${a.name}** — chosen` : a.name}`;
          const body = [
            a.barrier ? `The problem: ${a.barrier}` : '',
            a.lever ? `What it does: ${a.lever}` : '',
            `Who it reaches: ${a.entry}`,
            `When: ${a.timing}`,
            `Why it should work: ${a.mechanism}`,
            a.measurement ? `You would know it worked by: ${a.measurement}` : '',
            `What it gives up: ${a.tradeoff}`,
            a.chosen && a.whyChosen ? `Why this one: ${a.whyChosen}` : '',
          ].filter(Boolean);
          return `${head}\n  ${body.join('\n  ')}`;
        })
        .join('\n')}`
    : '';

  // The application's own verdict on whether those alternatives were real.
  //
  // Shown whenever it is not a clean "differentiated", and worded as the
  // application speaking rather than the agent — the user needs to know when
  // a comparison was claimed but could not be substantiated. Hiding this
  // would leave the agent's own framing as the only account of its work.
  const comparison =
    s.architectureComparison && s.architectureComparison.status !== 'differentiated'
      ? `\n\n**On those alternatives**\n${
          s.architectureComparison.status === 'insufficient'
            ? 'These were not materially different approaches.'
            : 'There was not enough here to compare approaches.'
        } ${s.architectureComparison.why}`
      : '';

  // Defects in the chosen design, stated plainly and separately from whether
  // the alternatives were real. Always shown when present: a campaign whose
  // own experiment cannot answer the question it claims to answer must say so
  // where the claim is made, not somewhere a reader has to go looking.
  const warnings = s.designWarnings?.length
    ? `\n\n**What this design cannot do**\n${s.designWarnings.map((w) => `- ${w}`).join('\n')}`
    : '';

  return (
    s.summary +
    arch +
    comparison +
    warnings +
    part('Approach', s.approach) +
    options +
    (s.rejected?.length
      ? `\n\n**Considered and not used**\n${s.rejected.map((r) => `- ${r.option} — ${r.why}`).join('\n')}`
      : '') +
    part('Success criteria', s.successCriteria) +
    part('Measurement', s.measurement) +
    part('Assumptions', s.assumptions) +
    part('Hypotheses for future testing', s.hypotheses) +
    group('strategic-ambiguity', 'Worth settling before this is built', true) +
    group('evidence-gap', 'Data that would improve this', false) +
    group('optional-preference', 'Defaults applied', true) +
    group('operational-limitation', 'Limitations', false) +
    // Approving the approach is not the same as the configuration being
    // buildable, so the two are stated separately and never merged.
    (readiness?.status === 'blocked'
      ? `\n\n**Cannot be generated yet**\n${readiness.blockers.map((b) => `- ${readableBlocker(b)}`).join('\n')}`
      : '') +
    (readiness?.limitations?.length
      ? `\n\n**Cannot be verified by the platform**\n${readiness.limitations.map((l) => `- ${l}`).join('\n')}`
      : '') +
    // Legacy shape, kept so an older model response still renders.
    part('Still unknown', s.unknowns) +
    // RULE 2.4. Shown rather than quietly corrected: the agent's claim and the
    // journey disagreed, and the person confirming should see which.
    (unsupported.length
      ? `\n\n**Claims the journey does not support**\n${unsupported
          .map((u) => `- ${u.option} was marked used, but ${u.gap}`)
          .join('\n')}`
      : '') +
    // Carried into this proposal without an answer. Never dropped silently:
    // if the agent chose to proceed past a question, the person confirming
    // sees which one and why.
    (() => {
      // Only questions that are STILL unanswered.
      //
      // Resolutions are first-wins and never cleared, so one recorded before
      // the user answered survives for the rest of the conversation. Measured:
      // a proposal listed the success measure and the barrier under
      // "Proceeding without an answer on" when both had been answered two
      // turns earlier — the reasons themselves began "Answered: ...". A
      // section meant to stop a risk going quiet was instead telling the user
      // that settled things were open.
      const open = carried.filter((c) => {
        const q = questions.find((x) => x.id === c.questionId);
        return !q || q.addressedInRound === undefined;
      });
      return open.length
        ? `\n\n**Proceeding without an answer on**\n${open
            .map((c) => {
              const q = questions.find((x) => x.id === c.questionId);
              const asked = q ? q.text : c.questionId;
              return `- ${asked} — ${c.kind === 'deferred' ? 'a default applies' : 'carried as a live uncertainty'}. ${c.why}`;
            })
            .join('\n')}`
        : '';
    })() +
    // Forks the application stopped blocking on, and what it assumed instead.
    //
    // This section is the whole justification for letting a fallback apply at
    // all. Asking a third time is a deadlock; silently choosing is worse. The
    // middle path is only honest if the choice is stated where the user is
    // about to approve the campaign, in their own question's words.
    (() => {
      const fallen = questions.filter(
        (q) => q.impact === 'fork' && q.addressedInRound === undefined && (q.blockedCount ?? 0) >= MAX_FORK_REFUSALS,
      );
      return fallen.length
        ? `\n\n**Asked twice, so I decided and moved on**\n${fallen
            .map(
              (q) =>
                `- ${q.text} — ${
                  q.contingency?.ifUnknown
                    ? `I went with: ${q.contingency.ifUnknown}`
                    : 'I had no stated default for this, so it stays an open decision for you to settle before launch.'
                }`,
            )
            .join('\n')}`
        : '';
    })()
  );
}

/** Short, factual summary after a build. The canvas carries the detail. */
function renderBuildSummary(
  strategy: Strategy | null,
  built: { graph: { nodes: Record<string, unknown> }; issues: { path: string; problem: string }[]; sendProposals: { stepName: string }[] },
  validation: ValidationReport,
  unresolved: number,
  exportable: boolean,
): string {
  const sends = Object.values(built.graph.nodes).filter((n) => (n as { type: string }).type === 'SEND').length;
  const lines = [
    `Built the journey: ${sends} message step${sends === 1 ? '' : 's'}, ${Object.keys(built.graph.nodes).length} steps in total. It is on the canvas now.`,
  ];
  if (unresolved) {
    lines.push(
      `\n${unresolved} message step${unresolved === 1 ? '' : 's'} still need an account and template ID from your bank. Open the step on the canvas to add them.`,
    );
  }
  if (validation.unverifiedHardConstraints.length) {
    lines.push(`\nStill to confirm before launch: ${validation.unverifiedHardConstraints.join(', ')}.`);
  }
  if (built.issues.length) {
    lines.push(`\nBuild issues:\n${built.issues.map((i) => `- ${i.path}: ${i.problem}`).join('\n')}`);
  }
  lines.push(exportable ? '\nYou can export the configuration now.' : '');
  if (strategy?.unknowns?.length) lines.push(`\nOpen questions: ${strategy.unknowns.join('; ')}`);
  return lines.filter(Boolean).join('\n');
}

/** Everything the model needs that is not conversation. */
function buildContextPrompt(
  req: OrchestratorRequest,
  brief: WorkingBrief,
  tenant: TenantConfig,
  kbText: string,
  availableChannels: Channel[],
  limitReached: boolean,
  isRefinement: boolean,
  isBuildTurn: boolean,
): string {
  // The same conditions the discovery gate applies, read here so the two
  // cannot disagree about whether designing may begin.

  return [
    `# Tenant\n${tenant.displayName} (issuer: ${tenant.issuer}). Synthetic prototype tenant.`,
    '',
    `# Working brief — everything established so far`,
    briefForPrompt(brief),
    '',
    `# Knowledge base (version ${req.knowledge.version})`,
    kbText,
    '',
    // ISSUER CONTEXT always. BUILDER VOCABULARY only once discovery is done.
    //
    // This block used to arrive in the opening message, every turn, carrying
    // the event names, the attribute lists, the step kinds and the list of
    // things the blueprint cannot express. So the agent knew how the builder
    // assembles a journey before it knew why customers were not converting,
    // and it reasoned in those terms — asking about filterable fields and
    // suppression lists while the business question went untouched. Gating
    // the lookup TOOLS did not fix that, because the terms were already here.
    //
    // Gated on the gate's own predicates rather than a round count, so the
    // vocabulary appears exactly when a proposal would be allowed: the user
    // has taken part, success is defined, both customer findings are
    // established, and nothing raised is still open.
    '# This issuer',
    issuerContext(availableChannels, tenant.templateLibraryAccess),
    '',
    isBuildTurn
      ? [
          '# Vocabulary you must stay inside',
          blueprintVocabulary(availableChannels, tenant.templateLibraryAccess),
          '',
          '# THIS TURN BUILDS THE APPROVED PLAN',
          // The design step lives here now, not in SYSTEM. It only ever
          // fires on a build turn, so carrying it on every discovery turn
          // was an instruction the agent could not act on.
          'BEFORE THE BLUEPRINT, STATE THE INTERVENTION ON ITS OWN: {"action":"design","intervention":[{"barrier":"<a barrier id from your own list>","does":"<what the journey does about it>","mechanism":"message|timing|branch|experiment|wait"}],"eligibility":{"entity":"<entity you would filter, or null>","exclude":["<who must never receive this>"]}}. Every entry must attack a named barrier; a step attacking nothing is decoration. "eligibility" is plumbing, never a choice to put to the user. I will tell you what the platform can meet; then build, and say what the gap costs.',
          'The campaign manager has approved the strategy above. Return ONLY {"action":"propose","strategy":{...unchanged...},"blueprint":{...}} — the blueprint expressing that plan, and the strategy exactly as approved.',
          'Build the plan that was agreed. If part of it cannot be expressed in the vocabulary above, DO NOT quietly build a lesser version: say which part and what is missing, in "openItems" as an "operational-limitation". A campaign that silently dropped a requirement is worse than no campaign and a plain reason.',
        ].join('\n')
      : [
          '# NO BLUEPRINT THIS TURN',
          'You do not have the builder\'s vocabulary, and you do not need it: nothing is being built yet. OMIT "blueprint" entirely.',
          'Describe the journey in "strategy.approach" the way you would explain it to the campaign manager — who is reached, what each message does and why, in what order, how long it runs, what it tests. That description IS the deliverable this turn.',
          'Design what would ACTUALLY WORK. Do not narrow it to what you imagine the builder supports, and do not hedge it: if the right answer needs something this platform may not have, propose it anyway and say so. Mapping it comes after they approve, and a plan that cannot be built tells us what to fix — which a plan quietly cut to fit would have hidden.',
        ].join('\n'),
    '',
    isRefinement
      ? `# You are REFINING an existing campaign\nCurrent configuration:\n${JSON.stringify(
          { ...req.currentCampaign, root: undefined },
          null,
          1,
        )}\nCurrent journey: ${Object.values(req.currentCampaign?.root?.nodes ?? {})
          .map((n) => `${n.type}(${n.label})`)
          .join(' -> ')}\nApply ONLY the change the user asked for and return a COMPLETE new blueprint, preserving everything else exactly.`
      : '',
    limitReached
      ? `# DISCOVERY LIMIT REACHED (${req.discoveryRounds}/${MAX_DISCOVERY_ROUNDS}). Return action:"propose" now. Every dimension still "open" must leave the record as a decision, not a silence: give it status "deferred" or "unavailable" with a note, and carry it into strategy.assumptions where it is safe to assume one, or strategy.unknowns plus a stated limitation where it is not. Do not drop one.`
      : `# Discovery budget: round ${req.discoveryRounds + 1} of ${MAX_DISCOVERY_ROUNDS}. Ask ONLY if an answer would change the strategy. If the brief is already clear enough, propose instead — do not pad to a question count.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Do two fingerprints describe the same subject? Used to check that a
 * confirmation belongs to the brief it is being applied to.
 */
function overlaps(a: string, b: string): boolean {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (!sa.size || !sb.size) return true;
  const shared = [...sa].filter((w) => sb.has(w)).length;
  return shared / Math.min(sa.size, sb.size) >= 0.25;
}
