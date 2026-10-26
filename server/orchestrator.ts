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
  humaniseModelError,
} from './anthropic';
import { runTool, toolTitle, toolsForPhase } from './agentTools';
import { outputToolsForPhase, isOutputTool, toolKind, applyOutputTool } from './outputTools';
import { decide, blockDelta, renderBlocks, turnPhase, type TurnPhase } from './gate';
import { saysProceed, saysBuildNow, receive, reopen, outstanding, REOPEN_LIMIT } from './record';
import { EventEmitterSeq, type RunEvent } from './runEvents';
import { auditOptions, applyAudit, unsupportedClaims, copyOnlyExperiments, journeyReacts, type OptionAudit } from './optionAudit';
import { compareArchitectures, checkFidelity, checkExperimentClaims, checkAudienceLearning, checkBarrierCoverage, checkBarrierTesting, JOURNEY_BEHAVIOURS } from './architectureAudit';
import { jargonNotes } from './plainLanguage';
import { journeySummary, longestSendPath, readableBlocker } from './journeySummary';
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
  recordQuestionResolutions,
  asImpact,
  asContingency,
  recordApplicationVerdict,
  type QuestionResolution,
  type QuestionImpact,
  fingerprint,
  newBrief,
  recordQuestions,
  recordEvidenceRequests,
  resolveEvidence,
  noteClosedOtherAxes,
  noteOpeningFacts,
  noteVolunteeredLimitation,
  briefForPrompt,
  objectiveChangedMaterially,
  recordDimensions,
  recordSuccessCriteria,
  recordBarriers,
  recordConverters,
  type QuestionContingency,
  recordContextChecked,
  outstandingDimensions,
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
import { buildFromBlueprint, issuerContext, type CampaignBlueprint, type BuildIssue, type SendProposal } from './blueprint';
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
  /**
   * Every customer-facing send in the chosen plan, in order.
   *
   * WHY A LIST AND NOT PROSE. A proposal read "a staggered multi-touch
   * sequence over the full 14 days, spaced by read/response rather than a
   * fixed clock" and named not one send. The manager approved a cadence they
   * could not see, and the Confirm turn then invented it from that sentence.
   * Under-dosing is invisible when the plan is a paragraph: three touches and
   * nine look identical on the page.
   *
   * Required by the tool schema with `minItems: 2`, so the provider refuses a
   * plan without it. Not a second journey model — it carries no node types,
   * no entities and no events, and the builder's grammar still arrives only
   * after approval. When the propose-turn preview lands, this is what it
   * should draw.
   */
  touches?: {
    /** Days after entry. 0 is the moment they enter. */
    day: number;
    channel: string;
    /** Which group this send is for. "all" when there is only one path. */
    path: string;
    purpose: string;
    /** What happens next if it does not land. */
    ifStillUnconverted: string;
  }[];
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
  /**
   * The provider's own words, kept verbatim.
   *
   * `reply` says what happened in a sentence a campaign manager can act on.
   * This carries the untouched text underneath it, because a humanised error
   * that HIDES the original forces whoever is debugging to go and find it —
   * and we have already lost one diagnosis today to a message that trimmed
   * the useful part away.
   */
  errorDetail?: string;
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
/**
 * The builder-vocabulary rule, which must not reach a discovery turn.
 *
 * MEASURED: this sentence told the agent to use only what "the tools report",
 * and on turn one — before anything had been asked — it went looking for an
 * entry event and opened with questions about which events exist. The rule is
 * correct at BUILD time and is kept verbatim for that; on a discovery turn it
 * points the agent at a vocabulary it has not been given and should not be
 * thinking in.
 */
const BUILDER_VOCAB_RULE =
  '- Use only the events, entities, attributes, values, channels and step kinds the tools report.';

const DISCOVERY_VOCAB_RULE =
  '- Do not go looking for events, entities or attributes yet. Nothing is being built this turn, so what the builder supports is not a question you need answered. Talk about customers and what should happen to them.';

/**
 * What the model is told when the journey it built is a clock.
 *
 * ON THE BUILD TURN, NOT IN `SYSTEM`. The cap this file keeps is on the
 * system prompt that travels on EVERY turn, and this is needed on one: the
 * turn after a build that did not react. A method rule read nine times to
 * change behaviour once is the expensive way to say this, and the standing
 * lesson here is that method prose has never changed what gets designed
 * anyway. The three sentences naming what does NOT count are the whole point
 * — each one is a thing the live build actually did instead.
 */
export const REACTION_RETRY =
  'The journey you sent is a clock. Send the SAME plan again with the fork it is missing — and put it only where it earns its place. ' +
  'A FORK BELONGS AFTER A SEND WHOSE ARMS WOULD DO DIFFERENT JOBS. The usual one is the first touch, when its job is awareness: someone who has not opened it still needs that same fact, sooner; someone who read it and did not book needs a different argument (what the instalment costs, how long the window stays open, last chance); someone who deleted it has dismissed the thread, so do not ping them again on that channel. ' +
  'WHERE EVERY ARM WOULD WAIT THE SAME TIME AND SEND THE SAME KIND OF REMINDER, DO NOT SPLIT — that is a clock with extra nodes. One or two designed checks on a whole path is the shape; a check after every message is not, and nested three-way forks on a four-touch path are unreadable. A last chance whose every arm exits needs no fork. Fallback SMS reports no read, so it needs none either. ' +
  'Use kind "branch" with no entity and no attribute and `statuses` on each path, taken from that channel\'s own list. Arms must not overlap: on WhatsApp, READ is not also DELIVERED. Say in "approach" which send you chose to read back and why that one. ' +
  'Do NOT add a FAILED, UNKNOWN or NOT_DELIVERED arm, and do not route the failure to another channel as a step: undelivered is `fallbackChannel` on the Send, and it stays exactly where it is. Never branch on QUEUED, SENT or PENDING — the message is still in flight and that is not a person. WhatsApp and SMS report no opens and no clicks, so never put OPENED or CLICKED on one; Email and RCS do report them. Do not add a converted arm: the goal check already takes booked people off the path. ' +
  'Different WAITS on each arm is not different jobs. A split on ticket size is segmentation, not a reaction — keep it, it is evidenced, but it is not this. Do not invent a second barrier. Keep every message, every day and every channel job you already had.';

/**
 * WHEN THE BUILDER'S GRAMMAR APPEARS, and it is two questions rather than one.
 *
 * It used to be a single boolean: a build turn saw everything, and every other
 * turn had the step grammar stripped. Discovery and propose are both "not a
 * build turn", so the turn that asks a campaign manager to approve a SEQUENCE
 * could not carry one — measured on `ui-s-1792748248345`, where
 * `propose_strategy` returned prose, `blueprint: false`, and the canvas was
 * invented after they had already signed.
 *
 * That was the wrong reading of strategy-before-platform. The rule it protects
 * is real and unchanged: WHILE STILL LEARNING WHO CONVERTS, do not talk
 * events, attributes or step kinds, because an agent handed the
 * filterable field list before it knows why customers behave then reasons in
 * those terms. It says nothing about the turn that puts a plan up for
 * approval.
 *
 *  - `asking`: the method is discovery only. The business-strategy chapters
 *    are cut, because nothing is being designed on this turn.
 *  - `ready`: the full method, so the path can be approved rather than
 *    imagined. The chat stays manager language; the steps live in the tool
 *    call.
 *  - `build`: the full method, unchanged.
 *
 * ONE ARGUMENT, FROM `turnPhase`. It took two booleans, and "not a build turn
 * and not allowed a journey" was a state each caller worked out for itself.
 */
export function systemForPhase(phase: TurnPhase): string {
  if (phase !== 'asking') return SYSTEM;
  const vocabAt = SYSTEM.indexOf(BUILDER_VOCAB_RULE);
  const base =
    vocabAt < 0
      ? SYSTEM
      : SYSTEM.slice(0, vocabAt) +
        DISCOVERY_VOCAB_RULE +
        SYSTEM.slice(SYSTEM.indexOf('\n', vocabAt + BUILDER_VOCAB_RULE.length));
  return discoveryOnly(base);
}

/** What an asking turn does not need, because nothing is being designed on it. */
const DROPPED_FROM_ASKING: [string, string][] = [
  // §3 to §8: the platform mapping, the sequence and entry event, the
  // hypothesis, the seven strategic options, the journey (NAME EVERY TOUCH, A
  // STEADY CADENCE, IF YOU WRITE BOTH) and the customer-facing copy. Every one
  // of them is about a campaign being designed. §9, about honesty over what
  // is settled, stays: it is about the record.
  ['3. The business strategy', '\n9. Honesty about what is settled.'],
  // STRANDED BY THAT CUT. The `openItems` kind-list is written for a propose
  // payload, the limitation paragraph under it names those kinds and means
  // nothing without them, and the last sentence — "Propose a complete,
  // coherent strategy even when something is open" — invites on an asking
  // turn precisely the move the asking-turn refusal exists to stop.
  ['When you propose, list what is still open in "openItems", each with a kind:', '\nOUTPUT'],
];

/**
 * THE ASKING PROMPT IS DISCOVERY ONLY, and it is a straight cut rather than a
 * rewrite.
 *
 * An asking turn had the whole design method — about 32,800 characters, most
 * of it about a campaign it may not design yet, read on every discovery round
 * of every conversation. It keeps the role, the three-question cap, the ban on
 * invented numbers and on quiet-hours/DNC/holdout questions, the ground rules,
 * §1 (the outcome, how success is judged, who converts and why the rest do
 * not), §2 (the dimensions and the one probe), §9, QUESTIONS AND OPEN ITEMS
 * and DISCOVER FIRST.
 *
 * NOT A SHORTENING OF THE METHOD. `SYSTEM` is untouched and both other phases
 * get it in full, so every pin in `promptMethod` — which reads the constant
 * out of this file's source — is unaffected. This slice only stops sending
 * the design chapters to a turn that is asking questions.
 *
 * IT THROWS ON A MISSING MARKER, deliberately. The alternative failure modes
 * are both silent and both worse: falling back to the full prompt would hand
 * the design method to a discovery turn with nothing to say so, and a slice
 * whose end marker has gone quietly becomes "the rest of the file" — which is
 * exactly how two tests in `emptyRoundRecovery` came to assert against
 * everything to EOF. Every test run imports this, so a broken marker cannot
 * reach a conversation.
 */
function discoveryOnly(prompt: string): string {
  let out = prompt;
  for (const [from, until] of DROPPED_FROM_ASKING) {
    const start = out.indexOf(from);
    // SEARCHED FROM `start`, and the second marker is where the cut STOPS
    // rather than the last thing it takes. Both of those are the difference
    // between keeping §9 and the OUTPUT chapter and silently eating them.
    const end = start < 0 ? -1 : out.indexOf(until, start + from.length);
    if (start < 0 || end < 0) {
      throw new Error(`systemForPhase: the asking prompt cannot be cut — marker missing: ${start < 0 ? from : until}`);
    }
    out = out.slice(0, start) + out.slice(end + 1);
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

const SYSTEM = `You are a campaign strategist for the card-programme marketing platform of the issuer named in the context. You design drip campaigns: multi-step customer journeys made of messages, waits, branches and exits.

You do the business reasoning. Deterministic application code builds the graph, validates it and owns every id, so you never emit node ids, edge ids, field names or template ids.

WHO YOU ARE TALKING TO. A campaign manager at that issuer. They run card programmes for a living and know their book. Write amounts, units and channel habits the way the knowledge base describes this market. Do not ask which country this is. They have never seen this system's internals. Write plain, complete sentences. Never show them an internal identifier: a question id, a principle code, a raw underscored event or enum name, or a path into the data. Name things in words, which is plainer AND more exact. Never narrate your own bookkeeping: "both fork questions are now answered", "per this round's scope", "(retained)" are this system talking to itself, and a fork is OUR word, not theirs. NEVER WRITE ANY OF THESE: "I've sent these questions", "to the campaign manager" or any third-person reference to the person you are addressing, "set aside" as a status, "(retained)", "fork", "dosage". You are not reporting to someone else about them; you are talking to them. A question that double-checks something is welcome. Reprinting a question they have already answered is not. Lead with what you now understand about THEIR business in the words they used. Report like a colleague: what you learned, what it changes, what you still need.

AT MOST THREE QUESTIONS THIS ROUND, and fewer is better. Ask them open. Never supply a sample answer, a rupee figure or a number of days alongside a question: a manager handed an example answers the example instead of telling you what is true.

NEVER ASK ABOUT QUIET HOURS, SUNDAYS, FESTIVAL DAYS, CHANNELS, DNC, NPA OR THE CONTROL GROUP. The campaign canvas already has those. Do not put a holdout in "touches". Asking for them reads as though you have not looked.

NEVER INVENT A PERFORMANCE NUMBER THE CONTEXT DOES NOT GIVE. Never claim a conversion lift, a cost saving or a performance number the context does not give. An expected effect is an untested hypothesis and must be labelled as one. If the knowledge base says there is no campaign history, do not invent a conversion rate, a benchmark or a prior learning. Say the first run establishes the baseline. The knowledge base already states no performance history exists for this bank, so do not ask for it again.

GROUND RULES
- Use only the events, entities, attributes, values, channels and step kinds the tools report. Anything else is rejected by the builder, so check before you commit to an entry trigger, a goal event, an attribute value or a channel — and never ask the user to confirm something a tool can tell you.
- A drop-off does not prove its cause. Do not assert causes you cannot evidence.
- Treat knowledge marked [status: invented] as unverified mock data.
- Respect the hard constraints in the knowledge base: the night quiet hours, and which channels this issuer actually has. Those two are not negotiable. Everything else there is a preference you may trade off. Say when you trade a preference off and why.

HOW TO DESIGN A CAMPAIGN

Work through this. Go deeper where the objective needs it and lighter where it does not. Do not narrate what you skipped: a list of the parts that did not apply tells the manager nothing and reads as padding. For each real decision, state the decision, what you relied on, and the trade-off you accepted.

1. The outcome and the behaviour.
   What business outcome is wanted, and what must the customer DO differently? Name the behaviour as an action, not a metric. Separate the user's business objective from the platform's formal goal: the goal is the event that proves the behaviour happened. If no event can prove it, say so — that is a limitation, not something to invent around.
   Then settle HOW SUCCESS WOULD BE JUDGED, and record it in "successCriteria". This is the business's own measure, not the goal event, and it is THEIRS to give. On your FIRST turn you must ASK for it — do not write yourself a "working definition" and carry on, which silently decides what the campaign optimises for. Only once they have answered, or said they have no target, may you record a working measure and say whose it is.
   THE METRIC THEY NAME MAY NOT BE THE VALUE THEY WANT. A count and a value pull in opposite directions: maximising the NUMBER of conversions favours whoever converts most easily, which is usually the smallest and least valuable cases. Ask yourself what the business actually gains when this number moves, and if the two could diverge, say so and ask which they mean. This is one question, asked once, and it changes who you target and how success is read.
   "measurement" is what to TRACK and how to EVALUATE it, plus what would be needed to measure it properly. Keep it qualitative and actionable. Never state a target, a historical result or a forecast of lift: any number here would be invented.

FIRST, FIND OUT WHO CONVERTS AND WHY THE REST DO NOT, and send "converters" and "barriers" on EVERY turn. You cannot propose without both. ASK. Never offer a list of likely reasons, and never supply your own. Every barrier needs a "quote" of their actual words: the application checks it against what they typed and marks an invented one an assumption, which no campaign may rest on. "They have no idea" is an answer; deciding it yourself is not. When nobody knows who converts, name two candidate TRENDS resting on different things and say how THIS run tells them apart. Do not wait for them to pick one and do not cut the journey on one: a trend nobody has seen is what the campaign MEASURES, not what it acts on.

2. The dimensions. Do this BEFORE you pick an entry event or design anything.
   Name the 3-5 things about THIS objective whose answers could genuinely change the campaign, and record each one in "dimensions". Derive them from the objective in front of you and from what the data can actually distinguish — never from a standard list of generic marketing dimensions. Customers differ from each other in ways that may matter: who they are, what state their account is in, what is blocking the behaviour, what amounts or balances are involved, when the opportunity appears. Say which of those matter here and which do not.
   A DIMENSION IS A BUSINESS OR CUSTOMER FACTOR, never a platform setting, and you DERIVE it from the objective in front of you: the test is whether the answer describes a customer and could change what someone gets. A REASON CUSTOMERS DO NOT ACT IS NOT A DIMENSION — it belongs in "barriers", and recording it here instead leaves "barriers" empty, which blocks the campaign no matter how complete this list looks. "They have not been nudged enough", "they think it costs too much", "they do not know the option exists": all barriers, none of them dimensions. A dimension is a factor that might SEGMENT these customers; a barrier is what is stopping them. Which event to enter on, which channels exist, which attribute the builder exposes, whether an event is confirmed live — those are IMPLEMENTATION questions. They matter, and they belong to the platform mapping you do after the business strategy is settled. They must not occupy the 3-5 slots, and an answer about them is not discovery.
   THE USER IS THE PRIMARY SOURCE for a dimension. Most of these cannot be looked up: only they know what they have seen in their own customers, what they believe is driving the behaviour, and which difference they think matters. Ask them.
   BUT DO NOT ONLY RECORD WHAT THEY RAISED. Proposing a factor they did not name is your job, not theirs: a user who could already name every factor that mattered would not need you. Name one or two yourself, derived from THIS objective, and say why each might matter. ASK WHAT THEY HAVE SEEN, NOT WHICH GROUP TO GO AFTER. Ask whether they have noticed a pattern in who does this already, or do not track it — both are answers. NEVER put up a menu of groups and ask which to target: the audience is already everyone eligible, and which trend holds is what this campaign exists to settle. ONE PATTERN IS NOT THE END: ask ONCE if anything else they SAW splits who acts, then lock. NAME THE AXES IN THAT ONE QUESTION: one or two nouns you derived from THIS objective, and ask whether they have SEEN a pattern there. Never "anything else?" with no noun in it. "We do not track that" closes it. TIME-TO-ACT IS TIMING, NOT AN AXIS. TWO SEEN AXES MEAN A CHOICE: cut on the one that moves their barrier. Do not invent a cutoff, a band or a rupee figure — that is the manager's to give.
   UNCERTAINTY WIDENS THE SEARCH, IT DOES NOT NARROW IT. When the user says they are not sure what the barrier is, that is the moment to put MORE candidate factors on the table, not to accept their hunch and move on. Another factor may correlate far more strongly than the one they guessed.
   A FACTOR YOU WILL NOT OPTIMISE FOR MAY STILL PREDICT THE OUTCOME. Being told success is counted rather than valued is a reason not to PRIORITISE the larger cases. It is not a reason to ignore how large they are, because large and small may convert at completely different rates. Only set a factor aside when it cannot be expressed at all, or when you have said plainly why it could not change who should get what.
   - Could the answer change the campaign? If not, do not raise it.
   - Does the user already know, believe or suspect something about it? Then ASK — set status "open" and put the question to them. A hypothesis of theirs is worth more than a guess of yours.
   - Have you already been told, or does the retrieved context already say? Then do not ask again; record it with basis "user" or "tool".
   NEVER close a dimension because the platform cannot express it. Ask the user whether it matters first, record what they say, and carry the unbuildability as a limitation for the mapping stage. A business factor that turns out to be unbuildable is still a finding the user needs; silently dropping it is the one outcome that is never acceptable, and do not substitute a loosely related attribute for the one that is missing or imply the targeting is possible. Missing numbers are likewise not a reason to drop a dimension — a strategically important factor with no data behind it stays in the record as a hypothesis.
   status is one of "open" (still investigating), "retained" (resolved and used), "deferred" (you chose not to pursue it, and the note says why) or "unavailable" (the platform cannot act on it — use this only AFTER the user has given their view, and keep that view in the note). basis is what the status rests on: "tool", "user", "user-belief", "assumption" or "none" — never claim "tool" or "user" for something you assumed. "user" is for what they OWN and are the authority on: their definition, their target, their decision. "user-belief" is for their explanation of WHY customers behave as they do — a conjecture about cause, which they cannot actually know and which competing explanations may contradict. Record a stated cause as "user-belief" every time, however confidently it was put to you; calling it "user" turns their guess into the finding your campaign rests on. Never invent a threshold, a bucket, a distribution or a rate to close one out.
   WEIGH EVERY QUESTION BEFORE YOU ASK IT, AND SAY HOW MUCH RIDES ON IT. Give each one an "impact": "fork" if two different answers mean two different campaigns — a different goal, a different audience, a different entry moment, a different core intervention; "shaping" if it changes how the campaign is built rather than what it is; "detail" if a sensible default exists and stating it costs nothing. Decide this when you ASK, not later: by the time you want to design, an awkward question is tempting to call a detail.
   A FORK YOU HAVE NOT HAD ANSWERED STOPS YOU. You may not infer it from something else they said, and you may not write it down as an assumption and carry on — both of those choose one of two campaigns for them. Ask it on its own, plainly, and wait. The cost of one short question is a turn; the cost of guessing is a campaign aimed at the wrong people. Anything that is not a fork may be carried (a live uncertainty the design works around) or deferred (a default you state), each naming its question id in "questionResolutions" with the reason. A reason attached to no question resolves no question.
   READ THEIR REPLY AS AN ANSWER FIRST. Assume it answers every question you asked, because it usually does: brief, reordered, or two in one clause all count. Put an id in "notCovered" only when nothing they wrote touches it. Never flag one for being short or not in the words you expected: telling them a reply you did receive did not count is wrong and insulting. FORKS ARE NOT AN EXCEPTION: a reply closes a fork too, and "notCovered" is the only thing that keeps one open. A skipped question is not a refusal: ask again plainly, or proceed saying what you assume and its cost.
   AN ANSWER IS NOT AUTOMATICALLY A CLOSED DIMENSION. Your first questions are the opening pass, not a questionnaire to get through. Read every answer back against what you had, and decide which of these happened:
   - It ANSWERED the question. Record it, basis "user", and move on.
   - It NARROWED the question. Broad causes hide competing explanations underneath them — "cost hesitation" could be the interest rate, the total payable, the tenure, or the effect on available limit, and those lead to different messages. If the distinction would change the design, you now have a sharper question, not an answer.
   - It RAISED something new. Something volunteered may open a dimension you had not thought of. Record it and ask.
   - It made another dimension IRRELEVANT. Close that one with a note and stop asking about it.
   A BROAD CAUSE IS NEVER SETTLED BY BEING STATED. When they name why customers behave as they do, you have their belief, not a finding — and underneath it sit competing explanations that imply different campaigns. Record it as "user-belief" and close it exactly two ways: ASK which one it is, or TEST them against each other. Accepting it as given and designing for one reading is the third way, and it is wrong: it hides a choice you made on their behalf. Choose asking when the answer would change the design and they are likely to know; choose testing when they genuinely cannot know, and say which you did and why.
   Ask a follow-up ONLY when the answer would change the audience, the intervention, the timing, the experiment or the measure. A question whose every possible answer leads to the same campaign is not worth a turn of the user's time — say so and move on. Stopping is a decision you must make deliberately and state, not a budget you pad to. This round still has at most three questions. "nothing further would change this" is itself a finding.
   If they cannot answer, that is an answer too. Do not resolve it for them: carry it into the strategy as an unknown with its consequence, and consider whether an experiment could settle what the conversation could not.
   Update the dimension you already have, reusing its name EXACTLY. A rephrased near-duplicate loses the history of what was asked and what came back.

3. The business strategy, before any platform mapping.
   From the dimensions, settle the audience approach, the intervention, the timing and how success will be read — in business terms, in your own words. Do not narrow any of it to what the builder happens to support yet. Then map it: the sequence and entry event below are where implementation starts, and where a business intention that cannot be built becomes a stated limitation rather than a quiet omission.
   THE AUDIENCE IS EVERYONE ELIGIBLE WHO HAS NOT DONE THE BEHAVIOUR YET. That is the entry — whoever can still do the thing, not a slice you already believe will convert. Narrowing it to the group most likely to respond is not strategy, it is abandoning the rest of the problem you were asked to solve. A TREND ABOUT WHO IS LIKELIER CHANGES THE TREATMENT, NEVER THE DOOR, and "I am not sure" does not shrink the entry either.
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
   EACH CANDIDATE MUST STATE ITS "barrier", "lever", "journey" AND "measurement". The barrier is the customer problem it addresses; the lever is what you do about it; "journey" is EXACTLY ONE OF ${JOURNEY_BEHAVIOURS.join(' | ')}. The application compares candidates on entry, timing and journey, and records two that match on all three as INSUFFICIENT. It also checks the winner's declared "journey" against what you actually build.
   A FACTOR THE FIRST CANDIDATE CANNOT CARRY IS NOT A PLATFORM LIMITATION. Before you report any discovered factor as unbuildable, check whether a DIFFERENT entry would carry it. "This entry cannot express it" is a fact about the entry you chose, not about the platform. If a second architecture would carry a factor that matters, prefer it unless you have a stronger reason not to — and if you keep the first anyway, say plainly that you traded the factor away and what that costs. Only when neither candidate can carry it is it a limitation.
   Then take each option below and give it a verdict: "used" (it earns its place, and why), "not-applicable" (why this objective does not need it) or "cannot-evaluate" (what you would need to decide). Record all seven in "strategyOptions", one line each. An option you never considered and one you weighed and set aside both read as silence, so say which it was.
   - Segmentation. Does any dimension you found divide these customers into groups that deserve a DIFFERENT treatment, rather than one treatment for everyone? Name the groups and what would differ between them. EVERY ELIGIBLE CUSTOMER IS STILL TREATED: a dimension splits the treatment inside the entry set — a different cadence, channel or copy — and never shrinks the entry to the best-looking bucket. The high-limit customers still enter; they may simply get fewer touches. If you split, give the remainder a path, so whoever is left still gets a campaign. When the manager has named the dimension, do not ask which group to target — ask only where the split sits, or default to the cohort's own median or tertiles rather than inventing a rupee cutoff, and use only as many buckets as their dimension actually needs. If the builder cannot express the axis, keep the buckets in the plan, say they cannot be built yet, and still message everyone on one path. Only call segmentation unavailable when no attribute can express the axis at all, never because nobody has named a number yet. IF THEY HAVE SEEN NO PATTERN, OR DO NOT TRACK IT: one track for everyone eligible, and THIS run has to produce the trend.
   - Experimentation. Is there a real competing hypothesis worth a controlled comparison? Say what is compared, how you would read the result, and what it would establish. Having no performance history is a reason TO test, not a reason to skip it: it stops you sizing an effect in advance, it does not stop you running the comparison. IF YOU CAN NAME THE ARMS, WRITE THEM — a test is never blocked on the user supplying copy. Name the competing explanations, give each arm a real intervention and real copy, state the outcome you would read and the comparison you would read it against, and say what is missing if anything genuinely is. Only call an experiment unavailable when the journey cannot express it, never because nobody has written the words yet. DERIVE THE COMPARISON FROM THIS OBJECTIVE: wording, dosage, channel, timing or order, whichever this one is actually uncertain about. Two message variants is one option, not the default, and adding sends tests nothing.
   - Conditional branching. Should what happens next depend on what the customer DID — converted, engaged but did not convert, or never engaged at all?
   - Channel fallback. What happens when delivery fails: retry, switch channel, or stop, and on what condition?
   - Adaptive sequencing. Should timing, channel or message change as the opportunity ages or as the customer responds?
   - Cost and fatigue. Weigh each additional message's incremental chance of converting against its cost and the irritation it adds. Name the weakest message and say why you kept or cut it.
   - Measurement and learning. What does this campaign teach, and against what comparison? Without a control group or a randomised comparison you can report what happened, never what the campaign CAUSED. Say which you have.
   Mark an option "used" only if the journey you are about to propose SHOWS it. A fixed chain of sends and waits is not adaptive sequencing however urgently its copy is worded; a fork whose branches do the same thing is not conditional branching; two experiment arms with the same steps are one treatment counted twice.
   Judge each on the business case, never on what the builder supports. Platform capability decides what gets BUILT, never what gets CONSIDERED: an option that is right for this business but unbuildable today is still recommended, kept in the strategy in full, with the limitation recorded separately. Never quietly downgrade it to a weaker thing the builder allows.

   SHOW WHERE EACH DECISION CAME FROM. Every entry in "approach" names what it rests on, inside the entry itself: what the user told you, what a tool reported, or that it is your own judgement with nothing confirming it. A reader must be able to tell THEIR requirements from YOUR recommendations without asking, and a decision that traces to nothing is an assumption — label it as one. If a later answer undercuts an approach you were heading towards, change it and say what changed it; never present a strategy that the accumulated answers no longer support.

7. The journey.
   A STEADY CADENCE IS A COMPLETE PLAN. Who-splits and a sensible clock are a campaign they can run; reacting to what the last message did is intelligence ON TOP, worth having where it changes the next job and not a pass mark. UNREAD AND READ ARE NOT TWO MORE AUDIENCES: the who-split stays as it is and the fork sits INSIDE a group — on the first send, and on a later one only if those two people need a different next job. If they would get the same reminder, do not fork. Make the copy match the arm: repeat the fact to someone who has not read it, change the argument for someone who has. IF YOU WRITE BOTH CANDIDATES, THE REACTING ONE WINS — do not describe the upgrade and then choose the calendar.
   NAME EVERY TOUCH. The window they gave you is the time you have to work an unfinished action, and "a staggered multi-touch sequence" names no sends. List them in "touches" across that window — the first, at least one reminder, a last chance before it closes. A group that mostly acts on its own gets FEWER touches as a NAMED path, never as everyone's default. Send count still does not make two architectures different.
   A SPLIT BELONGS INSIDE THE JOURNEY, NOT AT THE DOOR. Put the dimension on a condition, a branch or an experiment, so each group gets its own treatment and the remainder keeps a path of its own. Entry conditions decide who is ELIGIBLE; they are not segmentation, and the application does not accept them as it.
   Say what happens in each of these, as far as the channel can actually tell you:
   - it reached them and they did not open or read it;
   - they opened it and did nothing;
   - they converted, and the campaign stops for them.
   EACH CHANNEL EARNS A JOB OR IS EXPLICITLY UNUSED. Do not lead every path on WhatsApp because it is the default. Never name a channel the builder cannot send.
   BRANCH ONLY ON WHAT THAT CHANNEL REPORTS. Where list_channels is on the turn, call it for that channel's own status list; never invent one. WhatsApp reports DELIVERED, READ and DELETED. Never put a click or open condition on a WhatsApp or SMS send. FAILED IS NOT AN ARM: undelivered is the fallback channel field on the send. CHECK A SEND ONLY IF THE ARMS WOULD DIVERGE: one or two designed checks on a path, never one after every message.
   Size the plan to the window the customer has and to what the calendar says is happening. There is no per-campaign message limit: how many messages to send is YOUR decision to justify. Spacing is a judgement, not a rule. Respect the night quiet hours.
   Say what you considered and rejected, in "rejected", and make it a real alternative you chose not to take rather than a thing the builder cannot do. A platform gap belongs in the limitations, not here.
   The journey is where the options step becomes real: every option you marked "used" should be visible in it, and an option marked "used" that leaves no trace in the steps was not used.
   Simplest RELATIVE TO THE STRATEGY, not fewest steps. If the strategy treats two groups differently, a journey that treats everyone the same is not simpler, it is a weaker strategy.
   Recommend; do not hand the design back as a menu of questions.

8. The messages.
   Write each one as the CUSTOMER will read it. "copy" is the message itself, never a description of it and never an instruction to the campaign manager. Lead with what the customer gets, keep it short and plain, and put the action in "cta". Use \${customerFirstName} and \${shortUrl} where they help. Nothing you write is bank-approved, so never imply it is.

9. Honesty about what is settled.
   The working brief above separates what the user actually confirmed from what you assumed. Respect that line. If it lists an UNRESOLVED CONFLICT between something the user said and what the platform defines, do not design around it and do not substitute a different attribute or value for it: raise it, name the real alternatives, and let them choose. A value that is independently justified may stay — but the conflict is still theirs to resolve.

QUESTIONS AND OPEN ITEMS

"rejected" is for a decision you made between workable options. Something the platform CANNOT do is not a decision, and filing it there reads as "we chose against this" when the truth is "we could not express this" — keep it as the user's standing intent in "assumptions" or "unknowns", and raise the limitation. Ask only when the answer would change the design or is needed for a valid graph. Everything else gets a stated default. Never ask for message copy or CTA wording — write those yourself; asking them for message variants is asking them to do your job.

When you propose, list what is still open in "openItems", each with a kind:
- "strategic-ambiguity" — a business definition only the user can settle, which would change the design. Asked alongside your strategy.
- "evidence-gap" — aggregated data that would sharpen a decision. Never a prerequisite. Note what would have helped and move on.
- "optional-preference" — a detail with a sensible default. Put the default in "ifUnanswered".
- "operational-limitation" — something the platform cannot confirm either way, which you can disclose and still recommend around.
A LIMITATION THAT REACHES THE WRONG CUSTOMER IS NOT A LIMITATION, IT IS A DECISION. If the audience you can build would message people who have already done the thing, or who were never meant to hear from you, that is not a footnote — someone will receive it. Say who would wrongly receive it and what that looks like to them, and raise it as a "strategic-ambiguity" so they decide, not as an "operational-limitation" you have quietly accepted on their behalf.
An open item never suppresses your recommendation, so classify honestly: there is nothing to gain by hiding one or inflating another.

Nothing is built until the user confirms it. Propose a complete, coherent strategy even when something is open: say what you assumed and what would change your mind.

OUTPUT

Propose only once the user has answered at least one question AND no dimension is still "open". Closing every dimension yourself on the first turn is not discovery: you looked things up, you did not find out what the user wants, and a proposal on a turn where they have said nothing back is rejected by the application and handed to you as more discovery. Check the record above before you write one.

DISCOVER FIRST. This is the normal opening move, and usually more than one round. Check what you can actually reach before you ask: read the knowledge base and the bank context above, and report what you checked in "contextChecked" — one entry per source, with found true or false. Do not call event or attribute lookups while you are still learning who converts — those tools are for the turn that builds. Only name sources you genuinely consulted; you have no access to campaign history, analytics or bank systems, so never imply you looked there. Use discovery also when the objective is too vague to design against, or when a drip campaign is the wrong instrument for it entirely — say which, and why. Never repeat a question already answered.

Use "request_evidence" only when aggregated data would change a decision you are about to make, and the brief does not already say it is unavailable. Aggregated counts and rates only — never customer-level or personal data.`;

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
  const latestUserText = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  // The button sends `intent: 'confirm'` and a sentence. Typing that same
  // sentence sends only the sentence, and the turn quietly became a
  // conversation instead of a build. Same words, same outcome.
  const isBuildTurn =
    (req.intent ?? 'converse') === 'confirm' || isRefinement || saysBuildNow(latestUserText);
  const intent = req.intent ?? 'converse';
  const firstUserText = req.messages.find((m) => m.role === 'user')?.content ?? latestUserText;

  // The accumulated brief and the state machine. Both are the APPLICATION's
  // record, not the model's — they are what discovery is evaluated against.
  // A limitation stated in the opening brief counts. A live run had the user
  // say "we have no historical conversion data of any kind" in their very
  // first message; because the capture only ran on follow-up turns, it was
  // never recorded and the strategy carried the constraint in prose only.
  let brief: WorkingBrief = req.brief ?? noteOpeningFacts(newBrief(firstUserText), firstUserText);
  let session: SessionState = req.session ?? newSession();

  // Is the user answering a question we asked, or saying something new?
  //
  // This ordering matters and was a real bug: an ANSWER shares almost no
  // vocabulary with the objective ("Entry status is Initiated" vs "customers
  // are not converting"), so checking for a changed objective first treated
  // every answer as a brand-new brief and wiped the accumulated discovery.
  // An outstanding question means the message is an answer, full stop.
  // READ FROM THE ONE PLACE. This tested `answeredInRound`, the field
  // `recordAnswer` writes, while `outstanding` and `decide` read
  // `addressedInRound` — so a question `reopen` had put back was never treated
  // as awaiting a reply here either. `outstanding` is the record's own answer
  // to "what is still on screen".
  const awaitingAnswer = outstanding(brief).length > 0;

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
      if (awaitingAnswer) brief = receive(brief, latestUserText).brief;
    } else if (awaitingAnswer) {
      // THE ONE WRITE. `receive` records the answer AND closes the questions
      // that were on screen, in the same write — `recordAnswer` set only
      // `answeredInRound`, which `decide` does not read, so three live turns
      // of settled discovery were held on `awaiting-reply`
      // (`eval/runs/ui-s-1792839251135`). Its `proceed` flag is ignored here
      // on purpose: `limitReached` below already folds `saysProceed` together
      // with the round budget and the Skip & propose button, and a second
      // reading of the same sentence is the divergence this slice removes.
      brief = receive(brief, latestUserText).brief;
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

    // THE ONE-PATTERN PROBE, CLOSED BY THEIR OWN SENTENCE — on every converse
    // turn, including one where the questions are already marked addressed,
    // which is the state the live loop was stuck in.
    //
    // MEASURED, `eval/runs/ui-s-1792770967470` turns 4 to 7. The manager
    // closed the probe in turn 4; the agent wrote their closure into a
    // dimension NOTE reading "Manager confirmed they do not track any other
    // pattern beyond ticket size" and set `basis: 'none'`, while
    // `otherAxesProbed` reads `basis: 'user'`. The hold reprinted through
    // three more turns — and `brief.answers` never grew past turn 4 either,
    // because every question was already addressed and nothing recorded the
    // reply. Reading `latestUserText` directly is what makes this work in
    // exactly that state.
    //
    // Outside the branches above on purpose: each of those is conditional on
    // something (pending evidence, an outstanding question, a changed
    // objective) and this must not be.
    brief = noteClosedOtherAxes(brief, latestUserText);
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
  // THE ORDER A SEND FALLS BACK TO when the model names no channel.
  //
  // This list was sorted cheapest-first unconditionally, and `blueprint.ts`
  // takes `channels[0]`. For IBL the cheapest is EMAIL, so every send without
  // an explicit preference was built as email — while the bank context says,
  // in so many words, not to treat email as the default first touch because
  // it costs least. The plan on screen and the built journey disagreed about
  // the first channel, and nothing reported it.
  //
  // Now the issuer's own preference decides. When cheaper-first is on, the
  // old cost sort stands. When it is off, order by how Indian retail
  // cardholders actually read: WhatsApp, then SMS, then email, then RCS —
  // filtered to what the tenant genuinely has, so an unavailable channel
  // cannot be chosen by being high in the list.
  //
  // IN_APP is deliberately NOT here. It is not a channel the builder can
  // send on, and putting it in this list would let a send be built against
  // something that does not exist.
  const REACH_ORDER: Channel[] = ['WHATSAPP', 'SMS', 'EMAIL', 'RCS'] as Channel[];
  const cheapestFirst = Boolean(bank.softPreferences?.preferLowerCostChannelFirst?.value);
  const liveChannels = tenant.availableChannels.filter((c) => c.available);
  const availableChannels = (
    cheapestFirst
      ? [...liveChannels].sort((a, b) => a.relativeCost - b.relativeCost)
      : [...liveChannels].sort(
          (a, b) => REACH_ORDER.indexOf(a.channel as Channel) - REACH_ORDER.indexOf(b.channel as Channel),
        )
  ).map((c) => c.channel as Channel);

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
  em.emit('context.retrieval.started', 'understanding', 'Reading your brief and bank context', { status: 'running', correlationId: 'context' });
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
    `Campaign principles and bank context for ${tenant.displayName} (${req.knowledge.entries.length} entries)`,
    ...docsUsed.map((d) => `Document: ${d.filename}`),
  ];
  em.emit('context.retrieval.completed', 'understanding', 'Read your brief and bank context', {
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

  // "GO AHEAD" IS AN INSTRUCTION, NOT A HINT.
  //
  // MEASURED twice. A manager typed "ok go ahead", was refused, typed it
  // again, and the second one did not work either — the round budget expiring
  // did. Then with the tools live, two turns of "go ahead and build it" never
  // left discovery. `forceProposal` was set in exactly one place in the whole
  // application: a button click in CampaignDesigner.tsx. Nobody types into a
  // chat box expecting to have to find a button.
  //
  // Folded in HERE rather than at one call site, because this value feeds the
  // discovery gate's own escape AND the four vetoes computed separately from
  // it. Anywhere it is not consulted is somewhere a refusal can outlive the
  // instruction to stop refusing.
  const limitReached =
    req.discoveryRounds >= MAX_DISCOVERY_ROUNDS || Boolean(req.forceProposal) || saysProceed(latestUserText);
  // MAY THIS TURN WRITE A PATH? That, and not "is discovery finished", is
  // what releases the builder's grammar and the lookups to a non-build turn.
  //
  // IT USED TO EXCLUDE THE ESCAPES — proceeding was not enough, the gate had
  // to be unforced — and that was right only while a propose carried no
  // journey. (Phrased in words on purpose: the test guarding this greps for
  // the old expression, and quoting it here would defeat the guard.) Now the tool refuses a
  // plan with no `blueprint` and the gate holds a reactive plan without one,
  // so excluding them built a trap: a manager typing "go ahead", or a spent
  // round budget, produced a turn that MUST propose, with no `blueprint`
  // field in the schema and no lookups on the call, while the tool result and
  // the refusal both said "send the same plan with blueprint filled in". The
  // model could not comply.
  //
  // `limitReached` IS THE SAME INPUT THE TURN'S OWN DECISION USES — rounds
  // spent, `forceProposal`, or `saysProceed` on their latest message — and
  // `decide` short-circuits on it. Measured: without it, `decide(brief, {})`
  // sees the budget escape (it is on the record) and MISSES the typed one
  // entirely, because "go ahead" is a fact about the turn rather than the
  // record. A fix that read only the record would have left the half of the
  // trap a manager triggers by typing.
  //
  // So: every turn that may propose is a turn that writes a path, escapes
  // included. An asking turn is the only one left without the grammar.
  //
  // ONE FUNCTION, AND EVERY READER CALLS IT. This was `journeyAllowed`, a
  // boolean that four readers combined with `isBuildTurn` in four slightly
  // different expressions while `applyOutputTool` worked the answer out again
  // from the brief with no escape at all. `turnPhase` is the single fact; the
  // thunk stays a thunk because the brief is rewritten between model rounds
  // and round two of this turn may be ready when round one was not.
  const phaseNow = (): TurnPhase => turnPhase(brief, { isBuildTurn, limitReached });
  const context = buildContextPrompt(req, brief, tenant, kbText, availableChannels, limitReached, isRefinement, isBuildTurn, phaseNow());

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
  // Artefacts the model sent via tool calls rather than in a JSON payload.
  // Held across rounds because a tool call and the turn's final text can
  // arrive in different rounds of the same turn.
  let toolStrategy: Strategy | null = null;
  let toolBlueprint: CampaignBlueprint | null = null;
  let toolOpenItems: OpenItem[] = [];
  /**
   * A `propose_strategy` call that was REFUSED this turn, and what it carried.
   *
   * THE TURN THIS EXISTS FOR, `eval/runs/ui-s-1792735473522/turns/turn-3.json`.
   * The agent wrote a complete plan, the tool refused it twice on the
   * same-barrier rule, the agent went off trying to satisfy the refusal, and
   * the turn ended with the application telling the manager "Recorded." The
   * plan was in the request the whole time and nobody saw it.
   *
   * A refused proposal is not the same as nothing having happened, and the
   * reply must never again say it was.
   */
  let proposeRefused: { error: string; summary: string } | null = null;
  let toolEvidence: { question: string; fields: string[]; grouping?: string; period?: string; wouldInform: string }[] = [];
  // Did the model write to the record through tools this turn?
  //
  // This is what makes prose-only a SUCCESS rather than a parse failure. The
  // model is now told to write its message as ordinary text and put structure
  // in tool calls — so the correct shape for a turn is exactly the shape the
  // old code treated as unusable.
  let recordedViaTools = false;
  // Question ids already on the brief before this turn ran, so the client can
  // be shown what was asked NOW rather than everything still outstanding.
  const questionIdsBefore = new Set((brief.questions ?? []).map((q) => q.id));
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

  // COSMETIC ONLY, and deliberately computed before the loop so nobody reads
  // it as a gate: `decide` runs for real after the rounds finish. All this
  // decides is whether the activity row says the agent is answering the
  // manager or writing the plan, which is the difference between a turn the
  // manager should reply to and one they should read.
  const modelTitle = isBuildTurn
    ? 'Building the journey'
    : decide(brief).proceed
      ? 'Drafting the plan'
      : 'Writing a reply';

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
    // ONE PHASE FOR THIS ROUND, read by the prompt, the tool list, the handler
    // and the retry wrapper. Computed here rather than per reader so the
    // schema the model writes against and the handler that judges what comes
    // back cannot disagree inside one round.
    const phase: TurnPhase = phaseNow();
    // SAY WHAT IT IS DOING, NOT THAT IT IS THINKING.
    //
    // These titles were 'Agent thinking' and 'Agent continuing'. Both describe
    // our process rather than the manager's: "continuing" is only meaningful
    // if you know the turn runs in rounds, which is our implementation detail.
    // The row is correlated and resolves in place, so a later round keeps the
    // same sentence and the existing `detail` says which round it is — there
    // is nothing for a second title to add.
    em.emit('model.started', isRefinement ? 'review' : 'discovery', modelTitle, {
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
      // STOP RE-FETCHING THE CATALOGUE. DO NOT STOP THE BUILD.
      //
      // `stopLookingUp` existed to end a loop where the model re-read results
      // it already had. It did that by forbidding EVERY tool — and on a
      // Confirm turn the tool it forbade was `build_campaign`.
      //
      // Measured live, after the compiler crash was fixed: the manager
      // approved the plan and the agent replied that it could not build,
      // that its role stopped at proposing, and that the tool was not
      // available to it. That was a correct reading of what it had been
      // sent. The compiler never ran.
      //
      // So the withdrawal now applies to LOOKUPS only. On a build turn the
      // output tools always travel and `build_campaign` is forced, because a
      // turn whose entire purpose is to build has nothing else to decide.
      const withdrawLookups = stopLookingUp && !isBuildTurn;
      for await (const chunk of streamClaude({
        system: withdrawLookups
          ? `${systemForPhase(phase)}\n\nSTOP CALLING TOOLS. Every lookup you need has already been made and the results are above. Answer now with ordinary text and the tool call this turn needs, using what you already know.`
          : stopLookingUp
            ? `${systemForPhase(phase)}\n\nSTOP LOOKING THINGS UP. Every lookup you need has already been made and the results are above. Call build_campaign now with what you have.`
            : systemForPhase(phase),
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
        // A CONFIRM TURN CAN LOOK THE CATALOGUE UP FROM ROUND 0.
        //
        // `designSeen` starts false, so an approval arrived with `build_campaign`
        // and no `list_*` at all: the model had to write entity names, attributes,
        // operators and event types from memory on the one turn where every one of
        // them has to be exact. Measured live — "PIN Set", "within_days", an
        // operator cased as `equals` — none of which exist, all of which it could
        // have checked.
        //
        // Discovery is untouched: with `isBuildTurn` false and `designSeen` false
        // the lookup set is still empty, which is the rule that stops turn one
        // being a channel inventory.
        tools: [
          // The lookups go when they are exhausted; the output tools never do.
          // LOOKUPS TRAVEL WITH THE PATH, not with Confirm alone. A
          // propose-ready turn has to write steps, so it is the turn that
          // needs the real event names, attribute types, operators and
          // allowed values — withholding them until Confirm is what made the
          // agent write the catalogue from memory and the compiler drop the
          // conditions. Asking stays empty: all three operands false.
          ...(stopLookingUp ? [] : toolsForPhase(phase !== 'asking' || designSeen)),
          ...outputToolsForPhase(phase),
        ].map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        toolChoice: withdrawLookups
          ? { type: 'none' }
          : stopLookingUp
            ? // One thing left to do, so it is required rather than offered.
              { type: 'tool', name: 'build_campaign' }
            : undefined,
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
            // `kind` IS THE ONLY RELIABLE WAY TO TELL THESE APART, and the
            // client needs to: a lookup reads something the bank already
            // knows, an output tool writes to the conversation record. They
            // are not the same activity and only one of them is a "lookup".
            //
            // Stage cannot carry it. `requested` and `started` are emitted as
            // 'understanding' for every tool regardless of kind, and only the
            // `completed` emit differs — so counting by stage calls
            // `ask_questions` a lookup twice and a record-write once. That is
            // the second wrong count, not a fix for the first.
            data: { tool: chunk.toolUse.name, input: chunk.toolUse.input, kind: toolKind(chunk.toolUse.name) },
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
      // The user gets a sentence. The run log keeps the raw provider text,
      // because that is where a developer looks and where truncating it would
      // cost the diagnosis.
      const raw = (e as Error).message;
      const human = e instanceof AnthropicConfigError ? { message: e.message } : humaniseModelError(raw);
      const msg = human.action ? `${human.message} ${human.action}` : human.message;
      em.emit('model.failed', 'discovery', 'Agent call failed', { status: 'failed', detail: msg, data: { raw } });
      em.emit('run.failed', 'discovery', 'Run failed', { correlationId: 'run', status: 'failed' });
      yield* drain();
      return { ...base, phase: 'error', stage: 'error', reply: msg, errorDetail: raw, brief, session };
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
    // MEASURED on the first run with the tools live: the model did exactly as
    // instructed — called record_findings, ask_questions and record_dimensions,
    // then wrote its message as prose — and the application called that
    // "unusable", burned a retry, and logged "Could not read the agent's
    // answer". The turn had already succeeded.
    const unusable =
      !assistantText.trim() || (!extractJson(assistantText, stopReason).ok && !recordedViaTools);
    // THE BUILD IS NOT RECOVERED HERE ANY MORE, since 2026-10-22.
    //
    // This condition used to read `(unusable || mustBuild)`, with
    // `mustBuild = isBuildTurn && !toolBlueprint`, and ask for
    // `build_campaign` by `tool_choice`. Two things were wrong with that, and
    // the second is the worse one:
    //
    //  - `!toolUses.length` meant a Confirm that looked anything up — which
    //    build turns are allowed to do — could never reach it.
    //  - the retry below reads `chunk.text` and `chunk.done` and then breaks.
    //    It never collected `chunk.toolUse`, so the `build_campaign` call it
    //    forced was discarded unread.
    //
    // The forced build lives after the loop now, where its result is applied.
    // This recovery keeps the job it can actually do: a round that produced
    // nothing usable gets one more chance to answer.
    if (!toolUses.length && unusable && emptyRecoveries < MAX_EMPTY_RECOVERIES) {
      emptyRecoveries++;
      em.emit('model.started', isRefinement ? 'review' : 'discovery', 'That reply came back empty, asking again', {
        status: 'running',
        detail: assistantText.trim()
          ? 'The turn produced text that was not the expected JSON. Retrying once.'
          : 'The turn ended with no answer at all. Retrying once.',
      });
      yield* drain();
      const retryStart = Date.now();
      try {
        for await (const chunk of streamClaude({
          system: `${systemForPhase(phase)}\n\nYour previous turn did not produce a usable answer. Every lookup you need has already been made and the results are above. Reply NOW with ordinary text and the tool call this turn needs, complete, and nothing else.`,
          messages: conversation,
          tools: [...toolsForPhase(phase !== 'asking' || designSeen), ...outputToolsForPhase(phase)].map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
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
      em.emit('model.failed', 'discovery', 'Could not reach an answer this turn', {
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
    let lookups = 0;
    for (const tu of toolUses) {
      const started = Date.now();
      em.emit('model.tool_call.started', 'understanding', toolTitle(tu.name), {
        status: 'running',
        correlationId: tu.id,
        data: { tool: tu.name, kind: toolKind(tu.name) },
      });
      yield* drain();

      // WRITES TO THE RECORD, handled before any of the lookup machinery.
      //
      // These are not data fetches, so none of it applies: there is nothing to
      // cache, and recording a finding twice is not a wasted round the way
      // re-reading the event catalogue is. Routing them through the cache
      // would have counted a second `record_findings` as a "repeat" and
      // escalated against the model for doing exactly what it was told.
      //
      // The result handed back is `ok` or `error` from applyOutputTool, and an
      // error always says what to send instead — a tool result the model
      // cannot act on loops the same way a refusal the user cannot act on
      // does.
      if (isOutputTool(tu.name)) {
        const applied = applyOutputTool(brief, tu.name, tu.input);
        brief = applied.brief;
        if (applied.strategy) toolStrategy = applied.strategy;
        if (applied.blueprint) toolBlueprint = applied.blueprint;
        if (applied.openItems?.length) toolOpenItems = applied.openItems as OpenItem[];
        if (applied.evidence?.length) toolEvidence = applied.evidence as typeof toolEvidence;
        if (!applied.error) recordedViaTools = true;
        if (tu.name === 'propose_strategy') {
          // THE PAYLOAD IS FLAT. `propose_strategy` takes `summary`,
          // `approach`, `architectures` at the top level — `applyOutputTool`
          // reads it as `obj as Strategy` — so there is no `strategy`
          // wrapper to reach through. Reading one meant the fallback below
          // knew a plan had been refused and could never say what it was.
          // The nested read is kept as a second chance rather than removed,
          // because a model that wraps it is sending a plan either way.
          const sent = (tu.input ?? {}) as { summary?: string; strategy?: { summary?: string } };
          proposeRefused = applied.error
            ? { error: applied.error, summary: String(sent.summary ?? sent.strategy?.summary ?? '').trim() }
            : null;
        }
        em.emit(applied.error ? 'model.tool_call.failed' : 'model.tool_call.completed', 'discovery', toolTitle(tu.name), {
          status: applied.error ? 'failed' : 'ok',
          detail: applied.error ?? applied.ok,
          durationMs: Date.now() - started,
          correlationId: tu.id,
          data: { tool: tu.name, kind: 'output' as const },
        });
        yield* drain();
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          // A REFUSED PROPOSAL IS A CORRECTION, NOT A RESTART.
          //
          // The live turn shows what the bare error cost: refused twice, the
          // agent abandoned the plan it had already written and spent the
          // rest of the turn recording findings to satisfy the refusal. The
          // plan was never resent. Say plainly that the work is not lost.
          //
          // NOT ON THE ASKING-TURN REFUSAL, since 2026-10-24. This wrapper is
          // a PAYLOAD correction for a turn that is allowed to propose — "one
          // thing is wrong, fix it and resend". Appended to "discovery is not
          // finished", it tells the model to resend a plan it has just been
          // told it may not send yet, and that is what the live loop did:
          // five submits of the same thing, then the plan dumped into the
          // chat for the manager to approve by hand
          // (`eval/runs/ui-s-1792834072700` turn 3). The asking-turn refusal
          // names its own next move, which is to ask or to record.
          content:
            applied.error && tu.name === 'propose_strategy' && phase !== 'asking'
              ? `${applied.error}\n\nSend the SAME plan again with that one thing fixed — do not start over and do not go back to discovery. Cite barriers by their recorded ids. Two architectures may cite the SAME barrier as long as they differ in entry, timing, lever or journey: with one barrier recorded that is the normal shape, and the rival is a different treatment of it, never a second invented reason.`
              : applied.error ?? applied.ok ?? 'Recorded.',
          ...(applied.error ? { is_error: true } : {}),
        });
        continue;
      }
      lookups++;
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
        // The payload is what this event is FOR, so it stays at the top of
        // `data` and `kind` sits beside it rather than wrapping it.
        data: { tool: tu.name, kind: 'lookup' as const, result: out.result },
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
    repeatRounds = lookups > 0 && repeats === lookups ? repeatRounds + 1 : 0;
    conversation.push({ role: 'user', content: results });
  }

  // THE BUILD IS FORCED HERE, AFTER THE ROUNDS, AND THE RESULT IS APPLIED.
  //
  // THE LIVE FAILURE. A Confirm on the activation campaign: the model looked
  // the catalogue up, recorded findings, wrote "The journey is built…" as
  // prose, and never called `build_campaign`. The compiler never ran. The
  // manager read that sentence with the brief pane still beside it, because
  // the canvas draws `res.graph` and there was no graph — and underneath it,
  // gate text, since the held branch is the only place that prints the
  // model's prose next to a block. A real build says "It is on the canvas
  // now" from `renderBuildSummary`; the agent's own prose is not evidence
  // that anything exists.
  //
  // WHY THE EXISTING RECOVERY DID NOT CATCH IT, twice over:
  //
  //  - It was gated on `!toolUses.length`. Lookups came back to build turns
  //    on purpose — the one turn where entity names and operators have to be
  //    exact is the turn that should be allowed to check them — so from that
  //    moment a Confirm that looked anything up could never qualify as an
  //    empty round, however little it built.
  //  - It consumed only `chunk.text` and `chunk.done` and then broke out of
  //    the loop. So even when it did fire with `tool_choice: build_campaign`,
  //    the `tool_use` block it asked for was read by nobody and the blueprint
  //    was thrown away. It was forcing a build and discarding it.
  //
  // So the build no longer belongs to that recovery, which exists for a turn
  // that produced nothing usable. It belongs here: after every round is
  // finished, where the one question left is whether a journey arrived, and
  // where the answer can be acted on.
  //
  // NOTHING IS INVENTED. This asks the model for the journey a second time
  // and compiles what comes back. It does not synthesise a blueprint, it does
  // not promote the prose, and a call that throws or returns no journey
  // leaves `toolBlueprint` null — handled below as a build failure, which is
  // the honest outcome and the one the manager can act on.
  if (isBuildTurn && !toolBlueprint) {
    const forcedStart = Date.now();
    em.emit('model.started', 'generating', 'Asking for the journey itself', {
      status: 'running',
      correlationId: 'forced-build',
      detail: 'The plan is approved and the turn sent no journey. Asking for it directly.',
    });
    yield* drain();
    const forced: { id: string; name: string; input: Record<string, unknown> }[] = [];
    try {
      for await (const chunk of streamClaude({
        system: `${systemForPhase('build')}\n\nYour previous turn did not build the campaign. The manager has already approved this plan and is waiting for the journey. Call build_campaign NOW with what you have. If part of the plan cannot be expressed, build the rest and record the gap in "openItems".`,
        messages: conversation,
        // THE OUTPUT TOOLS ONLY. `tool_choice` forces `build_campaign`, so no
        // lookup could be called from here even if it travelled — and the
        // catalogue has already been read in the rounds above, which are in
        // this same conversation. Sending it again would be prompt weight for
        // a tool that cannot fire.
        tools: outputToolsForPhase('build').map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        toolChoice: { type: 'tool', name: 'build_campaign' },
        disableThinking: true,
        maxTokens: 32000,
      })) {
        if (chunk.toolUse) forced.push(chunk.toolUse);
        // `usage` is carried for cost reporting. `stopReason` and
        // `assistantText` are deliberately NOT touched: the manager's reply is
        // whatever the model already wrote, and re-reading this call's stop
        // reason against that text would change how the earlier turn parses.
        if (chunk.done) usage = chunk.done.usage;
      }
    } catch {
      // Fall through with no blueprint. The build-failure return below is the
      // honest outcome, and it keeps the provider's own text.
    }
    for (const tu of forced) {
      if (!isOutputTool(tu.name)) continue;
      const applied = applyOutputTool(brief, tu.name, tu.input);
      brief = applied.brief;
      if (applied.strategy) toolStrategy = applied.strategy;
      if (applied.blueprint) toolBlueprint = applied.blueprint;
      if (applied.openItems?.length) toolOpenItems = applied.openItems as OpenItem[];
      if (!applied.error) recordedViaTools = true;
      em.emit(applied.error ? 'model.tool_call.failed' : 'model.tool_call.completed', 'generating', toolTitle(tu.name), {
        status: applied.error ? 'failed' : 'ok',
        detail: applied.error ?? applied.ok,
        correlationId: tu.id,
        data: { tool: tu.name, kind: 'output' as const },
      });
    }
    em.emit('model.completed', 'generating', toolBlueprint ? 'The journey came back' : 'No journey came back', {
      correlationId: 'forced-build',
      status: toolBlueprint ? 'ok' : 'failed',
      durationMs: Date.now() - forcedStart,
      data: { toolCalls: forced.length, forcedBuild: true },
    });
    yield* drain();
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
  // A PLAN THE MANAGER ACTUALLY APPROVED, as opposed to a turn that merely
  // looks like a build turn.
  //
  // Two signals, and both are things the application itself knows:
  //
  //  - `intent: 'confirm'` is posted by the Confirm button and by nothing
  //    else.
  //  - `AWAITING_STRATEGY_CONFIRMATION` is our own record that a plan was put
  //    to them and is waiting on an answer. It covers the manager who types
  //    the sentence instead of pressing the button, which is a real approval.
  //
  // DELIBERATELY NOT `req.confirmedStrategy`, AND NOT BECAUSE IT IS EMPTY.
  //
  // An earlier version of this comment said the field never arrives. That was
  // wrong about the mechanism, and the correction matters in both directions.
  // (It is phrased this way on purpose: the test guarding this block greps for
  // the old wording, and quoting it here would defeat the guard.)
  // `CampaignDesigner` does populate it:
  // `setPendingStrategy(res.strategy ?? null)` on every non-error turn, posted
  // back as `confirmedStrategy` when `intent === 'confirm'` — pinned in
  // `canvasMustReact.test.ts`, because two checks now depend on reading it.
  //
  // It is not used HERE because this flag answers a different question. The
  // plan's CONTENT is read from `confirmedStrategy` (the reaction retry and
  // the fidelity check both do, further down, and would be inert without it).
  // Whether we may build at all must rest on what the APPLICATION knows,
  // because the content is client-supplied: a payload carrying a strategy is
  // not evidence that discovery happened.
  //
  // What this excludes is the point: someone who types "Confirmed. Build this
  // campaign." DURING discovery. `saysBuildNow` matches that sentence exactly
  // and it is on screen in their own transcript, so it does get typed — and
  // nobody should be able to skip discovery by repeating a sentence back.
  // Two jobs, two reads; moving either onto the other's signal breaks
  // something that currently works.
  const approvedPlan =
    isBuildTurn && ((req.intent ?? 'converse') === 'confirm' || isRefinement || session.state === 'AWAITING_STRATEGY_CONFIRMATION');

  let parsed = extractJson<
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

  // A plan sent by tool call, on a turn whose text was prose rather than JSON.
  // `parsed` has nothing in it, so the downstream reads need a value standing
  // in for the payload the model no longer sends.
  if (!parsed.ok && (toolStrategy || toolBlueprint)) {
    parsed = {
      ok: true,
      value: {
        action: 'propose' as const,
        strategy: toolStrategy ?? ({ summary: '', approach: [], assumptions: [], unknowns: [] } as Strategy),
        blueprint: toolBlueprint as CampaignBlueprint,
        openItems: toolOpenItems,
      },
    };
  }

  // AN APPROVED PLAN THAT PRODUCED NO JOURNEY IS A FAILURE, NOT MORE DISCOVERY.
  //
  // This is the exit the live Confirm needed and did not have. With no
  // blueprint, that turn fell through to the branches below — the record had
  // moved, so it returned the discovery phase with the model's "The journey
  // is built…" as the reply, or it was held by the gate and printed that
  // sentence above a block. Both put the brief back on screen beside a
  // sentence saying a campaign existed.
  //
  // The forced build above has already asked for the journey a second time.
  // If there is still nothing, the honest answer is the one the compiler's own
  // failure gives: nothing was built, nothing was changed, here is what to do
  // next. Never a graph, never a success sentence, and never the brief pane.
  if (approvedPlan && !toolBlueprint && !(parsed.ok && parsed.value.action === 'propose' && parsed.value.blueprint)) {
    em.emit('graph.generation.completed', 'generating', 'The journey could not be built', {
      status: 'failed',
      detail: 'The turn approved a plan and no journey came back, including from the forced build.',
    });
    em.emit('run.failed', 'generating', 'No journey was produced', { correlationId: 'run', status: 'failed' });
    yield* drain();
    return {
      ...base,
      phase: 'error',
      stage: 'error',
      brief,
      session,
      reply:
        'The journey could not be built from the approved plan. Nothing has been changed, so ask for a change or try again.',
      errorDetail: 'The agent did not return a journey on the build turn.',
      designGenerated: false,
      exportable: false,
      graph: null,
      campaign: null,
      strategy: null,
      blueprint: null,
      pendingBlueprint: null,
      usage,
    };
  }

  // THE RECORD MOVED, SO THE TURN WORKED.
  //
  // Checked before the parse-failure handling below, because with tool calls
  // there is nothing left to parse: the findings, dimensions and questions are
  // already in the brief, and the text IS the message to the manager rather
  // than a wrapper around a payload. Falling through to `!parsed.ok` would
  // report a defect on the turn shape we now ask for.
  // ONLY when the tool calls carried no PLAN. A strategy or a journey must go
  // through the propose/build path below, not this one.
  //
  // THE BUG THIS FIXES, found by a live run within an hour of writing it: this
  // branch returned `phase: 'discovery'` unconditionally, so a turn where the
  // model called `propose_strategy` — or `build_campaign` — had its plan
  // silently discarded and was reported as more discovery. The agent told the
  // manager "Built. Here's what's live in this journey:" and nothing had been
  // built. Eight turns of a real conversation never left discovery, including
  // two where the manager said "go ahead and build it".
  if (!parsed.ok && recordedViaTools && !toolStrategy && !toolBlueprint) {
    const prose = proseBefore(assistantText);
    em.emit('model.completed', isRefinement ? 'review' : 'discovery', 'Agent responded', {
      detail: 'Wrote its message as text and recorded the rest through tools.',
    });
    // `limitReached`, NOT `saysProceed` ALONE. Rounds spent and the Skip &
    // propose button are escapes too, and a status line that reads "Waiting for
    // your answer" on a turn the gate has already released is the same
    // divergence `turnPhase` exists to delete.
    const gateNow = decide(brief, { proceedRequested: limitReached });
    em.emit('run.completed', 'discovery', gateNow.proceed ? 'Ready to propose' : 'Waiting for your answer', {
      correlationId: 'run',
    });
    yield* drain();
    return {
      ...base,
      phase: 'discovery',
      stage: 'discovery',
      // NEVER "Recorded." AFTER A PROPOSAL WAS ATTEMPTED.
      //
      // The agent had written a plan; the application refused it on a rule
      // that has since been fixed, and then told the manager the turn had
      // produced a filing note. Whatever else is true, a turn that tried to
      // propose did not merely record.
      reply:
        prose ||
        (proposeRefused
          ? [
              proposeRefused.summary
                ? `I have a plan ready — ${proposeRefused.summary}`
                : 'I have a plan ready.',
              'I could not put it up this turn because it did not pass one of my own checks, and I ran out of attempts to fix it. Tell me to go ahead and I will send it again.',
            ].join('\n\n')
          : 'Recorded.'),
      // ONLY WHAT WAS ASKED THIS TURN.
      //
      // This returned `outstanding(brief)` — every question still open,
      // accumulated across the whole conversation. Measured live: the manager
      // answered "1. PIN setting 2. more cardholders activate", the agent's
      // own prose confirmed both were settled, and the screen listed them
      // again underneath. By turn three there were five questions showing,
      // two of them ones the agent had just said were answered.
      //
      // The brief keeps the history, which is right — it is the record. What
      // the client lists is this turn's ask, capped at the same three the
      // model is allowed to raise.
      questions: (brief.questions ?? [])
        .filter((q) => !questionIdsBefore.has(q.id))
        .slice(0, MAX_QUESTIONS_PER_ROUND)
        .map((q) => q.text),
      brief,
      session,
      strategy: null,
      blueprint: null,
      discoveryRounds: brief.rounds,
    };
  }

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
  // A BOUNDED RE-OPEN, NOT THE CLOSER. The reply closed these at ingest, so
  // `notCovered` is the model saying one specific question went untouched —
  // `reopen` puts it back, once, and `REOPEN_LIMIT` stops it becoming a way to
  // keep a manager answering the same thing for ever.
  brief = reopen(brief, parsed.value.notCovered);
  if (parsed.value.questionResolutions?.length) {
    brief = recordQuestionResolutions(brief, parsed.value.questionResolutions);
  }
  // What the agent says it consulted, kept as a record rather than prose.
  if (parsed.value.contextChecked?.length) {
    brief = recordContextChecked(brief, parsed.value.contextChecked);
  }
  // Settled on the propose turn, so the gate can tell a strategy that knows
  // what success means from one that never asked.
  const sentCriteria = toolStrategy?.successCriteria ?? (parsed.value.action === 'propose' ? parsed.value.strategy?.successCriteria : undefined);
  if (sentCriteria?.length) {
    brief = recordSuccessCriteria(brief, sentCriteria);
  }

  // A PLAN SENT BY TOOL CALL COUNTS AS A PROPOSAL.
  //
  // The JSON payload stays supported, deliberately, and this is not
  // indecision: the tool path is new and a turn that produces good reasoning
  // should not be thrown away because the model expressed it the old way. The
  // tool result is preferred where both arrive, because it is the one the API
  // validated against a schema.
  const proposed =
    toolStrategy !== null
      ? { action: 'propose' as const, strategy: toolStrategy, blueprint: toolBlueprint ?? undefined, openItems: toolOpenItems }
      : parsed.value.action === 'propose'
        ? parsed.value
        : null;

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

  // THE FOUR VETOES ARE GONE, 2026-10-16, and this is the whole point of the
  // collapse rather than a tidy-up.
  //
  // `beliefUntreated`, `forkUnanswered`, `dimensionUnresolved` and
  // `questionDropped` were computed here and ORed with the discovery gate's
  // own outcome. Each could refuse a proposal, none had to say what would
  // clear it, and none of them read the round budget until very late — so the
  // gate's escape hatch existed and was overridden, and the same refusal
  // regenerated for ever. Measured three turns running, then five.
  //
  // Every condition they tested is now a Block in `decide()` carrying the
  // mutation that clears it, which is why they could be DELETED rather than
  // ported. `gateClearability.test.ts` proves each exit works, so this is a
  // strictly stronger guarantee than the four of them provided.
  //
  // `forkUnanswered` has no successor at all: a reply now closes the questions
  // the application itself asked, and the protection against discharging a
  // fork by inference lives in `reopen`, bounded to one re-ask.

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

  // ===================================================================
  // THE DECISION, in one place.
  //
  // `decide()` is now the authority on whether the agent may propose, and
  // every refusal it returns carries the mutation that clears it. What follows
  // is a deliberate DEMOTION rather than a deletion: `evaluateDiscovery` keeps
  // its second job of supplying a fallback question when the agent has not
  // asked one, because "never leave a refusal with nothing to answer" is a
  // separate and still-correct rule. It no longer decides anything.
  //
  // WHY. Sixteen mechanisms could block the agent and none had to say what
  // would clear it. Three deadlocks came out of that in one session, and four
  // more causes out of one live run — every single one the same shape, a
  // refusal with no reachable exit. `clears` is a required field on Block, so
  // that shape is now unrepresentable rather than discouraged, and
  // `satisfy()` proves each exit actually works.
  //
  // The four orchestrator vetoes are GONE. Their conditions are blocks now,
  // with clearing mutations, which is why they could be deleted rather than
  // ported.
  const decision = decide(brief, {
    // THE SAME UNION THE SCHEMA USES. This read `saysProceed(latestUserText)`
    // while the tool phase read `limitReached`, so a spent round budget or the
    // Skip & propose button put `blueprint` in the schema and asked for a
    // plan, and then this held the plan that came back. `limitReached` folds
    // all three escapes; `evaluateDiscovery` below already took it as
    // `forced`, which is how the divergence stayed invisible.
    proceedRequested: limitReached,
    // The proposal is handed in so a belief-dependent design can be refused
    // on the turn it is written, which is the one check that cannot be made
    // from the record alone.
    // AND THE JOURNEY, WHEN THE TURN HAS ONE. The essay and the step list are
    // two outputs of one model call, so `reactionBlocks` checks them against
    // the same `journeyReacts` the build turn uses rather than trusting the
    // prose. Absent on today's first propose — `propose_strategy` has no
    // blueprint and `systemForPhase(false)` withholds the grammar on purpose
    // — and present on a refinement or any payload that carries steps.
    proposed: proposed
      ? { strategy: proposed.strategy, openItems: proposed.openItems, blueprint: proposed.blueprint ?? null }
      : null,
    // Already approved: the cadence question belonged to the propose turn.
    building: isBuildTurn,
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
  // ONE CONDITION. Previously this ORed the gate's outcome with four vetoes
  // computed separately, which is how a refusal survived the gate's own escape
  // hatch at the round budget and regenerated for ever.
  //
  // NOT ON AN APPROVED BUILD, since 2026-10-22, and this is the second half of
  // the empty-canvas failure. The forced build above gets a journey; this
  // branch could still throw it away, because it sits in front of the build
  // tail. In the live run it did: `belief-untested` was live — on a PIN/app
  // dimension the manager had explicitly rejected — so a Confirm produced a
  // held turn, and the manager read "The journey is built…" with the brief
  // still beside it.
  //
  // Refusing here is the same mistake the cadence block and the audience check
  // each made in turn, for the same reason: the moment to raise a gap in the
  // plan is BEFORE they approve it. Afterwards there is nothing they can do
  // with the refusal except approve again, and the campaign they agreed to
  // does not get built. So the blocks become limitations on the design, in
  // their own words, and the build goes ahead.
  //
  // `approvedPlan` is what keeps this narrow. A typed "Confirmed. Build this
  // campaign." mid-discovery is still held, because no plan was ever approved.
  if (!decision.proceed && !approvedPlan) {
    brief = recordQuestions(brief, withImpact(gate.questions));
    // The fork-refusal counter is gone with the veto that fed it. It counted
    // how often the APPLICATION had given up; the bound that matters is how
    // often the USER has been asked the same thing, and that lives in
    // `reopen` with a hard cap of one.
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

    // THE DIMENSION LEDGER IS NOT PART OF THE REPLY, since 2026-10-21.
    //
    // It used to be. The reply appended "What I am working through:", every
    // recorded dimension with a status suffix — "— set aside", "— still
    // looking into this" — and then "Correct anything that is wrong here, or
    // tell me to go ahead anyway."
    //
    // Measured on the PIN-activation run, turn 3. The manager read: "I have
    // put up two possible groups to go after and I am waiting to hear which
    // one you would back", followed by three bullets that were not those
    // groups, in our vocabulary rather than theirs — "set aside", "Manager
    // states higher assigned credit limit correlates with faster activation",
    // "a real candidate segmentation axis for dosage/intensity". That is the
    // lab notebook, pasted into a conversation.
    //
    // WHY IT WAS THERE, because the reason was real: an e2e failure where a
    // refused turn rendered neither a question nor a confirmation gate, so
    // the user had nothing to act on. The ledger was belt-and-braces for
    // that. The braces are enough — `renderBlocks` always emits at least one
    // part while the gate holds, and `gate.questions` carries the question —
    // so the invariant is now a test (`heldReplyIsNeverEmpty`) rather than a
    // paragraph of internal state shown just in case.
    //
    // The record itself is untouched: it stays on the brief, and it stays in
    // the `discovery.questions` event's `data` where the activity panel can
    // show it to whoever wants it.
    //
    // WRITTEN FROM THE BLOCKS, which each carry the mutation that clears them,
    // and as a DELTA against what was reported last turn. The cascade this
    // replaces picked one of four veto branches and restated the entire state
    // every time, which is why five progressing turns read as one stuck turn.
    const delta = blockDelta(decision.blocks, brief.lastBlocks ?? []);
    // THE MODEL'S OWN WORDS FIRST, WHEN IT WROTE ANY — then what is still
    // needed. Never the prose alone: on a held propose turn the prose
    // usually announces the plan ("New cardholders who have not set their PIN
    // enter a 14-day journey..."), and printing that by itself tells the
    // manager a plan is settled on the turn the gate refused it.
    const heldProse = proseBefore(assistantText).trim();
    const reply = [heldProse, renderBlocks(delta, decision.advice)].filter(Boolean).join('\n\n');

    brief = { ...brief, lastBlocks: decision.blocks.map((b) => b.code) };
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

  // `let`, because the reaction retry below may replace it. Everything
  // downstream — the option audit, fidelity, readiness, the build — must read
  // the journey that is actually going to be compiled.
  let { blueprint } = proposed;

  // =====================================================================
  // THE CANVAS MAY NOT BE A CLOCK WHEN THE PLAN PROMISED A REACTION.
  //
  // `eval/runs/ui-s-1792738033056` turn 4. The strategy the manager approved
  // declared branch-on-response and named a different channel for when the
  // first does not land. The build was ten WhatsApp sends, one condition on
  // Transaction Amount and an experiment of identical cadences — and the
  // reply read "Built the journey: 10 message steps… It is on the canvas
  // now."
  //
  // WHY THE EXISTING CHECKS DID NOT CATCH IT. `optionAudit` only DOWNGRADES a
  // `used` claim in the options table, which is a footnote under a success
  // sentence. `checkFidelity` would have compared the declared journey
  // against `derive()` — but `derive()` counts ANY condition as
  // branch-on-response, so a ticket-size split satisfies it. Both are
  // reports; neither is a consequence.
  //
  // ONE RETRY, THEN THE TRUTH. The model gets the same second chance the
  // empty-blueprint case gets, because the first miss is usually a miss
  // rather than a refusal. If the second journey is still a clock the
  // campaign is COMPILED ANYWAY — the same rule as a send with no
  // description: build it and report the gap, because an empty canvas helps
  // nobody — and the reply says plainly that the canvas is not the plan that
  // was approved.
  //
  // NOT SKIPPED ON `building`, unlike the propose-time blocks. That skip is
  // exactly why Confirm prints a clock today: the moment to catch a plan is
  // before approval, but the moment to catch a BUILD is when it is built, and
  // there is no earlier turn at which this journey existed.
  //
  // WHAT WAS APPROVED, and where it comes from. `req.confirmedStrategy` is
  // the plan the manager clicked Confirm on: the client sets its
  // `pendingStrategy` from `res.strategy` on every non-error turn and posts it
  // back with `intent: 'confirm'`. On a live Confirm the strategy THIS turn
  // carries is the synthetic empty one — measured on turn 4, `summary: ''`,
  // `architectures: []` — so reading only this turn would have made the whole
  // check inert in the app while passing every hand-fed test. That is the
  // `confirmedStrategy` trap from two slices ago, and the fallback order is
  // what avoids it rather than a comment saying so.
  const approvedStrategy = (req.confirmedStrategy ?? proposed.strategy) as Strategy | null;
  const chosenJourney = String((approvedStrategy?.architectures ?? []).find((a) => a?.chosen)?.journey ?? '')
    .trim()
    .toLowerCase();
  // The same two the propose-time block treats as reactive. A declared
  // `linear` does nothing here: `reactionBlocks` should have held that plan
  // before it was ever approved, and inventing a reaction the manager did not
  // agree to is not this function's job. No declared journey means no claim
  // to check, and guessing one would be the application designing again.
  const promisedReaction = chosenJourney === 'branch-on-response' || chosenJourney === 'wait-for-event';
  let reactionGap: string | null = null;
  if (isBuildTurn && promisedReaction && blueprint && !journeyReacts(blueprint)) {
    const retryStart = Date.now();
    em.emit('model.started', 'generating', 'The journey does not react, asking again', {
      status: 'running',
      correlationId: 'reaction-retry',
      detail: `The approved plan chose a "${chosenJourney}" journey and the one that came back is a timed sequence.`,
    });
    yield* drain();
    const again: { id: string; name: string; input: Record<string, unknown> }[] = [];
    try {
      for await (const chunk of streamClaude({
        system: `${systemForPhase('build')}\n\n${REACTION_RETRY}`,
        messages: conversation,
        tools: outputToolsForPhase('build').map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        toolChoice: { type: 'tool', name: 'build_campaign' },
        disableThinking: true,
        maxTokens: 32000,
      })) {
        if (chunk.toolUse) again.push(chunk.toolUse);
        if (chunk.done) usage = chunk.done.usage;
      }
    } catch {
      // Keep the journey we already have. A failed retry is not a reason to
      // lose a built campaign, and the gap below is reported either way.
    }
    for (const tu of again) {
      if (!isOutputTool(tu.name)) continue;
      const applied = applyOutputTool(brief, tu.name, tu.input);
      brief = applied.brief;
      if (applied.blueprint) blueprint = applied.blueprint;
      em.emit(applied.error ? 'model.tool_call.failed' : 'model.tool_call.completed', 'generating', toolTitle(tu.name), {
        status: applied.error ? 'failed' : 'ok',
        detail: applied.error ?? applied.ok,
        correlationId: tu.id,
        data: { tool: tu.name, kind: 'output' as const },
      });
    }
    const reacts = journeyReacts(blueprint);
    em.emit('model.completed', 'generating', reacts ? 'The second journey reacts' : 'The second journey is still a clock', {
      correlationId: 'reaction-retry',
      status: reacts ? 'ok' : 'failed',
      durationMs: Date.now() - retryStart,
      data: { toolCalls: again.length, reactionRetry: true, declared: chosenJourney },
    });
    yield* drain();
    if (!reacts) {
      reactionGap =
        'The journey on the canvas is a timed sequence. The plan you approved said the next step would depend on whether each message was delivered, read or acted on, and nothing in what was built branches on that. A split by ticket size is segmentation, and the goal check after each send is the platform checking whether they converted, not the campaign reacting.';
    }
  }

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
  //
  // BOTH READ THE PLAN THAT WAS APPROVED, not the one this turn happens to
  // carry. They used to read `proposed.strategy`, which on a Confirm is the
  // synthetic empty strategy — so on live turn 4 `checkFidelity` was handed
  // `architectures: []`, returned null, and the one check that exists to ask
  // "is this the campaign you were sold" never ran on the only turn where a
  // campaign gets built. On a propose turn `req.confirmedStrategy` is null and
  // this is `proposed.strategy`, so nothing about that path changes.
  const architectureComparison = compareArchitectures(approvedStrategy?.architectures);
  const fidelity = checkFidelity(approvedStrategy?.architectures, blueprint);
  // An experiment whose arms run the same journey can test wording and nothing
  // more. Folded into the comparison verdict rather than given its own field:
  // it is the same finding — alternatives that are not really alternatives.
  const copyOnly = copyOnlyExperiments(blueprint);
  let strategy = proposed.strategy
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
    em.emit('run.completed', 'strategy', 'Waiting for you to approve the plan', { correlationId: 'run' });
    yield* drain();
    // THE DOOR INTO GENERATION HAS TO BE OPEN WHEN THEY PRESS CONFIRM.
    //
    // This return used to leave the session wherever discovery had it —
    // measured: `AWAITING_USER_ANSWER` — and the table allows generation only
    // from `AWAITING_STRATEGY_CONFIRMATION`. That cost nothing while
    // `pendingBlueprint` was null, because the client then posted
    // `confirmedBlueprint: null` and Confirm fell through to the build tail,
    // which walks the hops itself. Now the client posts a real path and takes
    // the confirm short-circuit, where `mayGenerate` asks `canTransition`
    // directly: without these hops the first Confirm would come back
    // "Cannot generate from state AWAITING_USER_ANSWER" — the manager
    // pressing a button and being told no.
    //
    // `confirmation: null` and a new version for the same reason the later
    // propose path does it: a new plan is a new version, so a confirmation of
    // the previous one cannot authorise building this one.
    const toReady = transition(session.state === 'STRATEGY_READY' ? 'DISCOVERING' : session.state, 'STRATEGY_READY');
    session = {
      ...session,
      state: transition(toReady, 'AWAITING_STRATEGY_CONFIRMATION'),
      strategyVersion: session.strategyVersion + 1,
      confirmation: null,
    };
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
      // THE PATH TRAVELS WITH THE PLAN. `pendingBlueprint` is what the client
      // posts back as `confirmedBlueprint`, and it is what the left pane
      // draws through `previewFromBlueprint` — a preview that has had nothing
      // to draw since it was written, because this was `null`.
      blueprint: blueprint ?? null,
      pendingBlueprint: blueprint ?? null,
      // NO NUMBERED QUESTIONS BESIDE AN APPROVABLE PLAN.
      //
      // MEASURED on a live EMI run. The strategy arrived with Confirm and one
      // numbered question — "Does every EMI-eligible purchase share the same
      // 7-day expiry?" — and answering it is what took the manager off
      // Confirm: the reply became a discovery turn and the plan they were one
      // click from approving went back into the conversation. Clicking
      // Confirm instead produced the graph immediately. The highest-frequency
      // miss on this path is the PAIRING, not the compiler.
      //
      // The client renders this field as a numbered list under the agent's
      // message, which is right for discovery and wrong here: it reads as a
      // form the plan is waiting on, next to a button that says the plan is
      // ready.
      //
      // NOTHING IS HIDDEN. These items are `strategic-ambiguity` by
      // construction (`isBlockingItem`), they are already in
      // `gate.openItems` three lines above, and `renderStrategy` prints that
      // kind under "Worth settling before this is built". The manager reads
      // every one of them — as open points on a plan they may still approve,
      // rather than as a questionnaire.
      //
      // Discovery BEFORE a strategy is untouched: `ask_questions` still
      // returns numbered questions, still capped at three, and still records
      // them. There is no plan to approve there, so asking is the point.
      questions: [],
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
    // THROUGH `transition`, AND THROUGH GENERATION — this assigned the state
    // as a bare string. That skipped the throw the build tail hit, which only
    // made it quieter: the campaign still arrived without ever having passed
    // through `GENERATING_CAMPAIGN`, so the machine recorded a built campaign
    // that was never generated. A rule nothing is checked against is not a
    // rule, and a refinement rebuilds the journey exactly as a first build
    // does.
    session = { ...session, state: transition(session.state, 'GENERATING_CAMPAIGN') };
    const out = buildAndValidate(req, tenant, bank, availableChannels, blueprint, strategy, em, reactionGap);
    yield* drain();
    session = {
      ...session,
      state: transition(session.state, out.exportable ? 'EXPORT_ELIGIBLE' : 'CONFIGURATION_INCOMPLETE'),
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
  // Same rule as the propose return above, which is the one the app actually
  // reaches: open points travel as open items, not as a questionnaire.
  //
  // `recordQuestions` ran here. Recording them puts them on the brief as
  // OUTSTANDING, which makes the manager's next typed message an answer to a
  // question rather than a decision about the plan — so even on this path it
  // is the wrong bookkeeping for a turn that is asking for approval.
  const withQuestions = gate.outcome === 'strategy_with_questions';

  em.emit('strategy.proposed', 'strategy', 'Strategy ready for your review', {
    detail: withQuestions
      ? 'Nothing has been built yet. Some points are still open and are listed with the plan; confirm to build it as it stands.'
      : 'Nothing has been built yet — confirm to generate the campaign.',
    data: {
      summary: strategy?.summary,
      steps: blueprint.steps.length,
      openItems: gate.openItems,
      questions: gate.questions,
    },
  });
  if (withQuestions) {
    // Still recorded in the activity panel — the run should say what was left
    // open — but named as what it is now: points carried with the plan.
    em.emit('discovery.questions', 'strategy', `${gate.questions.length} point(s) still open on this plan`, {
      detail: gate.reason,
      data: { openPoints: gate.questions, round: brief.rounds },
    });
  }
  em.emit('run.completed', 'strategy', 'Waiting for you to approve the plan', { correlationId: 'run' });
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
          // "YOU TOLD ME" IS A CLAIM ABOUT THEM, so it is made only where the
          // record says they said it. An assumption is the agent's own rival
          // theory; quoting it back as their words was how a live Confirm
          // refused a build the manager had approved, over a sentence they
          // had never spoken. `mustBeAddressed` now filters assumptions out
          // entirely, so this is the second lock rather than the first.
          b.basis === 'user' || b.basis === 'user-belief'
            ? `You told me: ${b.statement} Nothing in this campaign does anything about it, so building it would leave the reason you gave untouched.`
            : `This campaign was designed around: ${b.statement} Nothing in it does anything about that, so there is nothing to learn from running it.`,
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
  // A FLAT JOURNEY IS A COST, NOT A REFUSAL.
  //
  // This blocked the build and asked "Which groups should this campaign
  // treat differently, so we can see who actually converts?" — the exact
  // question discovery was rewritten never to ask, arriving at the moment
  // the manager has least power to refuse it.
  //
  // Measured live on an EMI campaign: they said every eligible purchase, one
  // track, do not split. The application answered by requiring a split. A
  // design rule that overrules an explicit instruction is not a rule, it is
  // the application designing the campaign — and it contradicts the
  // segmentation principle directly, which says a dimension changes the path
  // and the manager had said there is no dimension.
  //
  // The cost is real and is still stated, in the same words: a campaign that
  // cannot tell its audiences apart returns one undifferentiated number, and
  // the next campaign starts as ignorant as this one. The holdout already
  // gives the comparison against sending nothing.
  // WHAT THE GATE WOULD HAVE REFUSED, said rather than dropped.
  //
  // The hold above is skipped on an approved build. Skipping it silently would
  // be worse than refusing: the cost would simply vanish on the one turn that
  // produces a campaign. Each block's `reason` is its manager-facing half, so
  // it lands verbatim under "What this design cannot do" — the same route the
  // audience gap takes below, for the same reason.
  if (!decision.proceed && approvedPlan) {
    const carried = decision.blocks.map((b) => b.reason).filter(Boolean);
    if (carried.length) {
      brief = recordApplicationVerdict(brief, { warnings: carried });
      if (strategy) {
        strategy = { ...strategy, designWarnings: [...(strategy.designWarnings ?? []), ...carried] };
      }
      em.emit('validation.started', 'strategy', 'Building with gaps still open', {
        status: 'ok',
        detail: carried.join(' '),
        data: { blocks: decision.blocks.map((b) => b.code) },
      });
      yield* drain();
    }
  }

  const audienceGap = checkAudienceLearning(blueprint, mustLearnAudience(brief.converters)) ?? untestedGuess;
  if (audienceGap) {
    brief = recordApplicationVerdict(brief, { warnings: [audienceGap] });
    // ON THE STRATEGY, not only on the brief. Recording a cost where nobody
    // reads it is the same as dropping it — `designWarnings` is what
    // `renderStrategy` prints under "What this design cannot do", so the
    // sentence reaches the manager verbatim instead of becoming an internal
    // note about a refusal that no longer happens.
    if (strategy) {
      strategy = { ...strategy, designWarnings: [...(strategy.designWarnings ?? []), audienceGap] };
    }
    em.emit('validation.started', 'strategy', 'This campaign will not learn who converts', {
      status: 'ok',
      detail: audienceGap,
    });
    yield* drain();
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
    // GENERATION IS TWO HOPS, and this path took one.
    //
    // `AWAITING_STRATEGY_CONFIRMATION -> GENERATING_CAMPAIGN -> (EXPORT_ELIGIBLE
    // | CONFIGURATION_INCOMPLETE)`. This jumped straight to the outcome, and
    // `AWAITING_STRATEGY_CONFIRMATION` legally reaches only `GENERATING_CAMPAIGN`
    // — the table calls it "the only door into generation" — so `transition`
    // threw and the manager's Confirm came back as "Illegal state transition
    // AWAITING_STRATEGY_CONFIRMATION -> CONFIGURATION_INCOMPLETE".
    //
    // THE TABLE IS NOT WHAT IS WRONG. Widening it to allow the jump would
    // delete the one guarantee it offers: that nothing reaches a built
    // campaign without passing through generation. The skip is the bug.
    //
    // WHY THIS PATH AND NOT THE SHORT-CIRCUIT ABOVE, which has always had both
    // hops: that one is guarded by `req.confirmedBlueprint`, the client sends
    // it from `pendingBlueprint`, and a propose turn returns `pendingBlueprint:
    // null` by design. So the guard never passes in the real app and EVERY live
    // Confirm lands here. The comment below already warned that no test walks
    // this path; that stayed true until the one covering this fix.
    session = { ...session, state: transition(session.state, 'GENERATING_CAMPAIGN') };
    const out = buildAndValidate(req, tenant, bank, availableChannels, blueprint, strategy, em, reactionGap);
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
    // EMPTY ON A PROPOSAL, always. The client renders `questions` as a
    // numbered list under the agent's message, and a numbered list beside
    // Confirm is the pairing that pulled managers off the approval. The open
    // points are in the reply under "Worth settling before this is built".
    questions: [],
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
  // GUARDED LIKE THE REAL BUILD. This is a dry run of the same compiler, on
  // the PROPOSE turn — so a hole here takes down a turn where nothing was
  // even being constructed. It was outside the guard added for Confirm, and
  // a readiness check that can crash the thing it is reassuring you about is
  // worse than no readiness check.
  //
  // An unanswerable question is reported as blocked, which is what it is: we
  // do not know whether this would build.
  let dry: ReturnType<typeof buildFromBlueprint>;
  try {
    dry = buildFromBlueprint(bp, {
      availableChannels,
      templateLibraryAccess: tenant.templateLibraryAccess,
    });
  } catch (e) {
    return {
      status: 'blocked',
      blockers: [
        `The journey could not be compiled to check it: ${e instanceof Error ? e.message : String(e)}`,
      ],
      limitations: [],
    };
  }
  const blockers = dry.issues.map((i) => `${i.path}: ${i.problem}`);
  return {
    status: blockers.length ? 'blocked' : 'ready',
    blockers,
    limitations: dry.limitations.map((l) => l.note),
  };
}

/** Builds the graph and validates it. Only ever called after confirmation. */
/**
 * THE COMPILER MAY NOT TAKE THE CONVERSATION WITH IT.
 *
 * A live Confirm died on "Cannot read properties of undefined (reading
 * 'replace')" — a model omitted a field the schema does not require, a
 * deep helper dereferenced it, and the throw escaped as a raw TypeError in
 * the transcript with no canvas and no way forward.
 *
 * The specific hole is fixed in `blueprint.ts` and `templateSelect.ts`. This
 * is the structural half: the build is the ONE place where an unbounded
 * amount of model-authored data meets application code, so the next hole —
 * and there will be one, because the schema cannot require everything the
 * compiler reads — costs a sentence rather than the session. The brief and
 * the session are returned untouched by the caller, so the manager can retry
 * or ask for a change.
 *
 * Deliberately NOT a catch around everything: only the compile-and-validate
 * step. A failure anywhere else still surfaces as itself.
 */
function buildAndValidate(
  req: OrchestratorRequest,
  tenant: TenantConfig,
  bank: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  availableChannels: Channel[],
  blueprint: CampaignBlueprint,
  strategy: Strategy | null,
  em: EventEmitterSeq,
  /** Set when the built journey does not react and the approved plan said it would. */
  reactionGap: string | null = null,
): Partial<OrchestratorResponse> & { stage: Stage } {
  try {
    return buildAndValidateUnguarded(req, tenant, bank, availableChannels, blueprint, strategy, em, reactionGap);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Resolves the row `graph.generation.started` opened, so the activity
    // panel does not leave a spinner turning on a run that is over.
    em.emit('graph.generation.completed', 'generating', 'The journey could not be built', {
      status: 'failed',
      detail,
    });
    return {
      stage: 'error',
      // One sentence for the manager, the provider's own text kept beside it
      // — the standing rule that the raw error is never swallowed.
      reply:
        'The journey could not be built from the approved plan. Nothing has been changed, so ask for a change or try again.',
      errorDetail: detail,
      designGenerated: false,
      exportable: false,
      graph: null,
      campaign: null,
    } as Partial<OrchestratorResponse> & { stage: Stage };
  }
}

function buildAndValidateUnguarded(
  req: OrchestratorRequest,
  tenant: TenantConfig,
  bank: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  availableChannels: Channel[],
  blueprint: CampaignBlueprint,
  strategy: Strategy | null,
  em: EventEmitterSeq,
  reactionGap: string | null = null,
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

  em.emit('validation.started', 'validating', 'Checking the journey', { status: 'running' });
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
    reply: renderBuildSummary(strategy, built, validation, unresolvedSends.length, exportable, reactionGap),
    strategy,
    blueprint,
    pendingBlueprint: null,
    campaign,
    graph: built.graph,
    provenance: proposal.provenance,
    unresolvedCampaignFields: proposal.unresolvedCampaignFields,
    // FIRST, AND AS A BLOCKER RATHER THAN A FOOTNOTE. A journey that does not
    // do what the approved plan said it would is the most important thing
    // about this build, and the option-audit downgrade it also produces is a
    // line in a table nobody scrolls to.
    campaignBlockers: [...(reactionGap ? [reactionGap] : []), ...(proposal.blockers as string[])],
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
    reopened?: number;
    contingency?: QuestionContingency;
  }[] = [],
  /** Claims the proposed journey did not bear out. RULE 2.4. */
  unsupported: { option: string; gap?: string }[] = [],
): string {
  if (!s) return 'Here is the strategy.';
  // A STRING IS NOT A LIST. The schema asks for arrays; the model still
  // sends a single sentence. `.length` is truthy on a string, then `.map`
  // throws — measured live, `s.rejected.map is not a function`, on the turn
  // that should have put Confirm on screen. Coerce here so a wrong shape
  // omits a section instead of crashing the reply.
  const asLines = (items: unknown): string[] =>
    Array.isArray(items)
      ? items.map((i) => (typeof i === 'string' ? i : String((i as { option?: string })?.option ?? i ?? ''))).filter((i) => i.trim())
      : typeof items === 'string' && items.trim()
        ? [items.trim()]
        : [];
  const rejectedRows = (raw: unknown): { option: string; why: string }[] => {
    if (typeof raw === 'string' && raw.trim()) return [{ option: raw.trim(), why: '' }];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((r) => {
        if (typeof r === 'string') return { option: r, why: '' };
        if (r && typeof r === 'object') {
          const row = r as { option?: string; why?: string };
          return { option: String(row.option ?? '').trim(), why: String(row.why ?? '').trim() };
        }
        return { option: '', why: '' };
      })
      .filter((r) => r.option);
  };
  const part = (title: string, items?: unknown) => {
    const list = asLines(items);
    return list.length ? `\n\n**${title}**\n${list.map((i) => `- ${i}`).join('\n')}` : '';
  };

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
          //
          // EVERY LINE IS CONDITIONAL. Four of them were not, and printed
          // `undefined` to a campaign manager — measured on the
          // PIN-activation proposal, which showed "Who it reaches:
          // undefined", "Why it should work: undefined" and "What it gives
          // up: undefined" under both candidates.
          //
          // The field names have been reconciled at the tool boundary, so
          // those three now carry what the model wrote. This stays
          // conditional anyway: a line is worth printing when it says
          // something, and a label with nothing after it is worse than the
          // label's absence — it reads as a question put to the manager
          // ("who does this reach?") about a plan that already said.
          const head = `- ${a.chosen ? `**${a.name}** — chosen` : a.name}`;
          const line = (label: string, value: string | undefined) =>
            value && value.trim() ? `${label}: ${value.trim()}` : '';
          const body = [
            line('The problem', a.barrier),
            line('What it does', a.lever),
            line('Who it reaches', a.entry),
            line('When', a.timing),
            line('Why it should work', a.mechanism),
            line('You would know it worked by', a.measurement),
            line('What it gives up', a.tradeoff),
            a.chosen ? line('Why this one', a.whyChosen) : '',
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

  // THE SEQUENCE, AS A LIST. This is the thing the manager is approving and
  // it used to exist only as a clause inside the chosen architecture's
  // `timing` — "a staggered multi-touch sequence over the full 14 days" —
  // which names no sends. Three touches and nine read identically in prose,
  // so under-dosing was invisible at exactly the moment it could still be
  // corrected. Grouped by path, because "the high-limit group gets fewer"
  // is a claim worth seeing rather than taking on trust.
  const byPath = new Map<string, NonNullable<Strategy['touches']>>();
  for (const t of s.touches ?? []) {
    const key = t.path?.trim() || 'all';
    byPath.set(key, [...(byPath.get(key) ?? []), t]);
  }
  const touches = byPath.size
    ? `\n\n**The sequence**\n${[...byPath.entries()]
        .map(([path, list]) => {
          const head = path === 'all' ? '' : `*${path}*\n`;
          const rows = [...list]
            .sort((a, b) => (a.day ?? 0) - (b.day ?? 0))
            .map(
              (t) =>
                `- Day ${t.day}, ${t.channel}: ${t.purpose}${
                  t.ifStillUnconverted ? `\n  If it does not land: ${t.ifStillUnconverted}` : ''
                }`,
            )
            .join('\n');
          return `${head}${rows}`;
        })
        .join('\n')}`
    : '';

  return (
    s.summary +
    touches +
    arch +
    comparison +
    warnings +
    part('Approach', s.approach) +
    options +
    (rejectedRows(s.rejected).length
      ? `\n\n**Considered and not used**\n${rejectedRows(s.rejected)
          .map((r) => `- ${r.option}${r.why ? ` — ${r.why}` : ''}`)
          .join('\n')}`
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
      // Keyed on `reopened`, not the deleted `blockedCount`.
      //
      // NEARLY LOST IN THE GATE COLLAPSE: nothing sets `blockedCount` any
      // more, so this whole section would have stopped rendering silently —
      // and it is the one place a question the application decided to stop
      // asking is disclosed at the moment the user approves. The counter
      // changed; the obligation did not.
      const fallen = questions.filter(
        (q) => q.impact === 'fork' && (q.reopened ?? 0) >= REOPEN_LIMIT,
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
export function renderBuildSummary(
  strategy: Strategy | null,
  built: {
    graph: { nodes: Record<string, unknown> };
    issues: { path: string; problem: string }[];
    sendProposals: { stepName: string }[];
    limitations?: { attribute: string; note: string }[];
  },
  validation: ValidationReport,
  unresolved: number,
  exportable: boolean,
  /**
   * The journey was built and it is not the one that was approved.
   *
   * THE SUCCESS SENTENCE IS NOT AVAILABLE IN THIS CASE, which is the whole
   * point of the parameter. "Built the journey… It is on the canvas now." is
   * what the manager read on a turn that produced a vanilla drip against a
   * plan promising a reaction, and the mismatch sat three paragraphs down in
   * an options table. A build that did not do what was agreed is reported in
   * the first line or it is not reported at all.
   */
  reactionGap: string | null = null,
): string {
  const sends = Object.values(built.graph.nodes).filter((n) => (n as { type: string }).type === 'SEND').length;
  // A DRIP CAMPAIGN WITH NO MESSAGES IS NOT A BUILT CAMPAIGN.
  //
  // This sentence was unconditional, so the live failure read "Built the
  // journey: 0 message steps, 4 steps in total. It is on the canvas now." —
  // under a canvas holding an entry, an experiment and two exits. Twelve
  // designed steps had been dropped and the summary announced a success.
  //
  // The compiler bugs that produced that case are fixed, which makes this a
  // safety net rather than the main event. It stays because the rule does:
  // never tell someone a thing was built when it was not.
  const lines = sends === 0
    ? [
        `Generation did not produce any message steps, so there is no campaign to review yet. ${Object.keys(built.graph.nodes).length} structural step${Object.keys(built.graph.nodes).length === 1 ? '' : 's'} were created.`,
      ]
    : reactionGap
      ? [
          // Counted honestly — the steps exist and the canvas is drawn — and
          // then the mismatch, in the same breath rather than underneath.
          `${sends} message step${sends === 1 ? '' : 's'} and ${Object.keys(built.graph.nodes).length} steps in total were built, and you can see them on the canvas. I am not going to call that done.`,
          `\n${reactionGap}`,
          '\nTell me to fix it and I will rebuild the journey so each message depends on what happened to the last one, or say go ahead and it stays a timed sequence.',
        ]
      : [
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
  // DID THE BUILD MATCH THE PLAN THEY APPROVED?
  //
  // `touches` is a second description of the same journey, and two
  // descriptions drift — that is the bug class this codebase has been bitten
  // by three times (an architecture's field names, two event-label maps, one
  // session slot against a keyed store). The answer is not to delete one of
  // them: the manager approves the list, and the builder needs the blueprint.
  // It is to CHECK them against each other and say so.
  //
  // Counted, never coerced. The graph is what the agent built; if it carries
  // fewer sends than the approved plan the honest move is to report the
  // difference, not to quietly add steps nobody designed or to edit the plan
  // so it agrees.
  // PATH DENSITY, NOT TOTALS. The first version compared the number of
  // approved touches against every SEND node in the graph, and the two are
  // not the same measure: a two-arm wording experiment builds the same
  // skeleton twice, so four approved touches become eight SEND nodes and the
  // banner reported a four-message shortfall on a correct build. A banner
  // that cries drift when nothing drifted teaches people to ignore it.
  //
  // What a customer experiences is one route through the journey, so that is
  // what is compared: the fullest path of the plan against the longest path
  // of the graph. Counted, never coerced — no step is invented to make the
  // numbers agree, and the plan is not edited either.
  const byPathCount = new Map<string, number>();
  for (const t of strategy?.touches ?? []) {
    const key = t.path?.trim() || 'all';
    byPathCount.set(key, (byPathCount.get(key) ?? 0) + 1);
  }
  const plannedDensity = Math.max(0, ...byPathCount.values());
  if (plannedDensity) {
    const builtDensity = longestSendPath(built.graph as never);
    if (plannedDensity !== builtDensity) {
      lines.push(
        `\nThe plan you approved names ${plannedDensity} message${plannedDensity === 1 ? '' : 's'} on its fullest path and the journey was built with ${builtDensity} on its longest path.` +
          (builtDensity < plannedDensity
            ? ' Open the canvas to see which ones are missing before this goes anywhere.'
            : ' Worth a look before this goes anywhere.'),
      );
    }
  }

  // WHAT THE PLATFORM COULD NOT EXPRESS, said out loud.
  //
  // `limitations` is where a dropped condition goes — an attribute this
  // entity does not have, an operator the builder does not accept. It was
  // computed, returned, and never shown, so the campaign manager saw a
  // journey that silently filtered on less than they asked for. It is also
  // the capability backlog: an agent reaching for "PIN Set" is telling us
  // what to build next, and that only works if somebody reads it.
  const gaps = built.limitations ?? [];
  if (gaps.length) {
    lines.push(`\nPlatform cannot express yet:\n${gaps.map((g) => `- ${g.attribute}: ${g.note}`).join('\n')}`);
  }
  // NOT WHEN THE JOURNEY IS NOT THE ONE THAT WAS APPROVED. Offering the
  // export in the same breath as "this does not match your plan" is the
  // success sentence coming back through a different door.
  lines.push(exportable && !reactionGap ? '\nYou can export the configuration now.' : '');
  if (strategy?.unknowns?.length) lines.push(`\nOpen questions: ${strategy.unknowns.join('; ')}`);
  return lines.filter(Boolean).join('\n');
}

/** Everything the model needs that is not conversation. */
export function buildContextPrompt(
  req: OrchestratorRequest,
  brief: WorkingBrief,
  tenant: TenantConfig,
  kbText: string,
  availableChannels: Channel[],
  limitReached: boolean,
  isRefinement: boolean,
  isBuildTurn: boolean,
  /**
   * WHICH TURN THIS IS, from `turnPhase`. `isBuildTurn` is still a parameter
   * because several branches below read it directly, and it is the same fact:
   * `phase === 'build'`.
   */
  phase: TurnPhase = 'asking',
): string {
  // The same conditions the discovery gate applies, read here so the two
  // cannot disagree about whether designing may begin.

  return [
    `# Tenant\n${tenant.displayName} (issuer: ${tenant.issuer}).\nMarket, currency, how customers read, quiet hours, risk appetite, and whether any campaign performance history exists are in the knowledge base below. Read them. Do not invent a market or a past result.`,
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
    // HOW TO WRITE THIS TURN. Lives here rather than in SYSTEM because the
    // per-turn context has no character cap, and because it describes the
    // mechanics of one turn rather than the method.
    //
    // THE DEFECT THIS ADDRESSES: the whole reply was one JSON object, so it
    // opened with `{` and the UI had no prose to show. `stripJson` fell back
    // to scraping "summary" out of half-finished JSON with a regex, and on a
    // propose turn — where the summary is the seventh field — the manager
    // watched a hardcoded "Working on the campaign strategy..." for most of
    // the longest turn in the product.
    '# How to write this turn',
    [
      'Write your message to the campaign manager as ORDINARY TEXT. It streams to them as you type it, so it is the first thing they see.',
      // ONLY THE TOOLS THAT ARE ACTUALLY ON THIS CALL. This sentence named
      // all five on every turn, including `build_campaign` on a discovery
      // turn where it is not registered — and naming a tool the model cannot
      // call is how a live Confirm came to reply that the build was
      // unavailable to it. The agent reads this list as what it may do.
      isBuildTurn
        ? 'Put everything structured in a tool call instead: "build_campaign" for the journey you are building now, "record_findings" for anything new they have told you about customers, "record_dimensions" for what could change this campaign, "ask_questions" if something genuinely blocks the build. "propose_strategy" is NOT on this turn: the plan is already approved.'
        : phase === 'ready'
          ? 'Put everything structured in a tool call instead: "propose_strategy" for the plan AND its path, "record_findings" for who converts and what is stopping them, "record_dimensions" for what could change this campaign, "ask_questions" for anything still open. The lookup tools are on your list this turn as well. "build_campaign" is NOT: they approve the path first.'
          : 'Put everything structured in a tool call instead: "ask_questions" for questions, "record_findings" for who converts, what is stopping them AND how they would judge success the moment they say it, "record_dimensions" for what could change this campaign, "request_evidence" for aggregated data that would change a decision. Neither "propose_strategy" nor "build_campaign" is on this turn, and neither are the lookup tools — nothing is being designed yet. File what they have told you; the plan tool arrives on the turn the record supports one.',
      'Call record_findings on EVERY turn where they have told you anything about customers, including a turn where you are proposing. The application reads your tool calls, not your prose, so a finding left in the text alone does not exist as far as the gate is concerned.',
      'Do not restate in text what you have already put in a tool call. Say what you now understand and what it changes.',
    ].join('\n'),
    '',
    '# This issuer',
    issuerContext(availableChannels, tenant.templateLibraryAccess),
    '',
    // THE CATALOGUE IS A TOOL CALL, NOT A PASTE.
    //
    // It used to be pasted here on every turn that might design — every event
    // name, every entity's attribute list, the step kinds, the "cannot
    // express" list — and gating the lookup TOOLS did nothing while the terms
    // were already in the first user message. Both halves are now the same
    // decision: the turns that write steps get the lookups, and nobody gets
    // the paste. `issuerContext` above stays on every turn, because which
    // channels this issuer has is bank context and shapes a strategy.
    //
    // ONE JOINED STRING PER BRANCH. These were nested arrays with the
    // catalogue glued inside them, so a single join produced a wall with the
    // whole vocabulary on one line.
    phase === 'ready'
      ? [
          '# THE PLAN YOU PUT UP MUST CARRY ITS PATH',
          'Send the journey in `propose_strategy`\'s "blueprint" — the same step grammar build_campaign uses. They are approving a sequence, so they have to be able to see it. Keep your MESSAGE in their language: no step kinds, no attribute names, no entity names in the chat.',
          'LOOK IT UP BEFORE YOU WRITE IT. The lookup tools are on your list this turn: list_event_types for entry and goal events and which entity each category filters, list_audience_attributes for every attribute with its type, operators and allowed values, list_step_types for what a step may route on, list_channels for what each channel reports. An attribute, event, operator or value that is not in what they returned does not exist — Confirm compiles THIS path, so a name you guessed here becomes a condition dropped from their canvas.',
          'Do NOT call build_campaign this turn. They approve the path first, and Confirm compiles this same one.',
        ].join('\n')
      : isBuildTurn
        ? [
          '# THIS TURN BUILDS THE APPROVED PLAN',
          'BEFORE THE BLUEPRINT, STATE THE INTERVENTION ON ITS OWN: {"action":"design","intervention":[{"barrier":"<a barrier id from your own list>","does":"<what the journey does about it>","mechanism":"message|timing|branch|experiment|wait"}],"eligibility":{"entity":"<entity you would filter, or null>","exclude":["<who must never receive this>"]}}. Every entry must attack a named barrier; a step attacking nothing is decoration. "eligibility" is plumbing, never a choice to put to the user. I will tell you what the platform can meet; then build, and say what the gap costs.',
          'The campaign manager has approved the plan above. CALL build_campaign NOW — that is the only thing this turn is for, and the tool is on your list. Do not describe the journey instead of building it, do not return a blueprint as text, and never tell them the build is unavailable to you: it is not, and saying so leaves them with an approval that did nothing.',
          'If part of the plan cannot be expressed, call the tool anyway with everything that CAN be built and put the rest in "openItems" as an "operational-limitation". A journey with a stated gap is worth more to them than a message explaining why there is no journey.',
          'CHECK, DO NOT RECALL. An attribute, event or operator that is not in what the tools returned does not exist: never write the name anyway. Build every step the platform CAN express, leave the one it cannot out, and record it in "openItems" as an "operational-limitation" naming what you needed and the closest real field the tools showed you. That gap is how we find out which drip capability to add next, so it is worth more written down than worked around.',
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
