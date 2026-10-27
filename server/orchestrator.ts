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
import {
  SHARED_OPENING,
  DISCOVERY_BODY,
  PLAN_BODY,
  CONFIRM_BODY,
  DISCOVERY_STICKY,
  PLAN_STICKY,
  CONFIRM_STICKY,
} from './promptManuals';
import { outputToolsForPhase, isOutputTool, toolKind, applyOutputTool } from './outputTools';
import { decide, blockDelta, renderBlocks, turnPhase, alignJourneyClaim, shapedBlueprint, type TurnPhase } from './gate';
import { saysProceed, saysBuildNow, receive, reopen, outstanding, REOPEN_LIMIT } from './record';
import { EventEmitterSeq, type RunEvent } from './runEvents';
import { auditOptions, applyAudit, unsupportedClaims, copyOnlyExperiments, journeyReacts, type OptionAudit } from './optionAudit';
import { compareArchitectures, checkFidelity, checkExperimentClaims, checkAudienceLearning, checkBarrierCoverage, checkBarrierTesting } from './architectureAudit';
import { jargonNotes } from './plainLanguage';
import { journeySummary, longestSendPath, readableBlocker } from './journeySummary';
import { longestSendSteps } from './pathReading';
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
import { mayGenerate, newSession, transition, invalidateConfirmation, type SessionState } from './campaignState';
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
 * Is the `{"action":"design"}` handshake live? No.
 *
 * It is gated rather than deleted because `capability.test.ts` pins the design
 * step inside the model loop with source-text assertions, and a grepped symbol
 * that disappears fails a test for a reason unrelated to what the test is
 * about. This makes the branch unreachable without removing anything a pin
 * reads, and it is the single place to flip if the handshake is ever wanted.
 */
const DESIGN_HANDSHAKE_LIVE = false;

/**
 * Explicit conversation phases. The server decides the phase; the client
 * renders it. Nothing is inferred from "does a graph exist" — that inference
 * is what let generation run before the strategy was agreed.
 */
export type Phase =
  | 'understanding'
  | 'discovery'
  /**
   * The brief is closed and the PLAN is not approvable yet.
   *
   * Added 2026-10-26 because the application had one word for three different
   * situations. `discovery` meant "the record is open", "the plan is held" and
   * "the model wrote an essay" all at once, so a manager whose brief was
   * finished and whose journey was on file read "Waiting for your answer" with
   * no question on screen and no button —
   * `eval/runs/ui-s-1792984906680` turns 3 and 4.
   *
   * On this phase: no numbered questions, no Confirm, and the journey IS
   * drawn, because there is a path and the only thing missing is a change to
   * it. The plan tool stays on the next turn — `turnPhase` reads the record
   * and never sees a plan-hold.
   */
  | 'revising'
  /**
   * The brief is closed and there is NO path on file yet.
   *
   * REVISE REQUIRES A FILED PATH. MEASURED,
   * `eval/runs/ui-s-1792991223125` turn 3: a settled record, no journey ever
   * sent, and the response said `revising` with `pendingBlueprint: null` — no
   * Confirm, an empty canvas, and a sentence claiming the plan was "above".
   * `revising` with nothing to revise is the lie; this is the honest name for
   * it, and the job of the turn is `propose_strategy`.
   *
   * No Confirm, no canvas, no numbered questions, and `turnPhase` stays
   * `ready` so the plan tool is on the next call.
   */
  | 'planning'
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
 * How to write this turn. It rides the END of `systemForPhase`.
 *
 * It used to travel in the context message instead, which is built once per
 * send and pushed onto `conversation` — while the method prompt and the tool
 * list are rebuilt every round from `phaseNow()`. A send that closed the
 * record with `record_findings` therefore gave round two Plan tools with a
 * Discovery sticky still in the history. Appended to the per-round system
 * string it cannot disagree with the turn it is describing, and the model
 * still reads it last.
 */
export function stickyForPhase(phase: TurnPhase): string {
  return phase === 'build' ? CONFIRM_STICKY : phase === 'ready' ? PLAN_STICKY : DISCOVERY_STICKY;
}

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
 * THERE IS NO "FULL METHOD" ANY MORE, and this comment used to say there was.
 * Each phase gets its OWN manual — a shared opening plus that phase's body —
 * so none of them is a cut-down or a superset of another:
 *
 *  - `asking`: the Discovery manual. Find out about the customers and the
 *    business; do not design the journey, do not pick an entry event, and do
 *    not go looking for events or attributes.
 *  - `ready`: the Plan manual, shared by Plan and Revise. Two approaches, one
 *    journey, and the path travels in the tool so they can approve what they
 *    can see. The chat stays manager language; the steps live in the tool.
 *  - `build`: the Confirm manual. Compile the path they approved — no
 *    greenfield, no second approach, no reopening who converts.
 *
 * It is NOT the old scissors cut, and the difference matters: the asking
 * prompt is a document of its own rather than the plan prompt with its
 * business-strategy chapters removed.
 *
 * ONE ARGUMENT, FROM `turnPhase`. It took two booleans, and "not a build turn
 * and not allowed a journey" was a state each caller worked out for itself.
 */
export function systemForPhase(phase: TurnPhase): string {
  // THE STICKY RIDES THIS STRING, not the context message.
  //
  // It used to live inside `buildContextPrompt`, which is built ONCE per send
  // and pushed onto `conversation` as the first user message. The tool list
  // and this prompt are both recomputed per ROUND from `phaseNow()`, and
  // `record_findings` can close the record mid-send — so round two of one send
  // could be handed Plan tools and a Plan method with a Discovery sticky still
  // sitting in the history telling it there is no plan tool on this turn.
  //
  // Rebuilding the context message instead would mean either two stickies in
  // the history or mutating a message already sent. This string is new every
  // round anyway, so the sticky simply comes with it.
  return `${SHARED_OPENING}\n\n${BODY[phase]}\n\n${stickyForPhase(phase)}`;
}

const BODY: Record<TurnPhase, string> = {
  asking: DISCOVERY_BODY,
  // PLAN AND REVISE SHARE THIS STRING. The heading inside it already covers
  // both cases — "If no path is on file yet, send one. If a path is already on
  // file, change that path" — so there is nothing for a fourth phase to say.
  ready: PLAN_BODY,
  build: CONFIRM_BODY,
};




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
/**
 * The correction a refused `propose_strategy` is answered with, on a turn that
 * is ALLOWED to propose.
 *
 * ONE DEFINITION, TWO CALLERS: the round loop, and the forced propose. It was
 * inline in the round loop and the forced call had no correction at all, which
 * is the whole of `eval/runs/ui-s-1792996412937` turn 3 — the refusal text was
 * written, emitted as `model.tool_call.failed`, and never became a
 * `tool_result`, so the model never read it. Two copies of this string would
 * drift, and the drift would be invisible because each site passes its own
 * tests.
 *
 * NOT FOR AN ASKING-TURN REFUSAL. See the round loop's own note: appended to
 * "discovery is not finished" it tells the model to resend a plan it has just
 * been told it may not send yet.
 */
/**
 * The `tool_result` for one applied output tool.
 *
 * ONE DEFINITION, so the round loop and the forced propose cannot answer the
 * same refusal differently. They did: the round loop had this expression
 * inline and the forced call had its own copy, which is how the forced call
 * came to have no correction at all for a while
 * (`eval/runs/ui-s-1792996412937` turn 3 — the refusal was emitted as an
 * event and never became a `tool_result`, so the model never read it).
 *
 * The correction rides only on a refused `propose_strategy`, and only on a
 * turn that is ALLOWED to propose: see `PROPOSE_CORRECTION`'s own note for why
 * appending it to an asking-turn refusal made a live run submit the same plan
 * five times.
 */
/**
 * What a yes is TOLD about the plan it approved. Never what it is refused for.
 *
 * ONE DEFINITION, because the two Confirm doors used to disagree about this
 * completely: the button checked none of it, and a typed yes was REFUSED by
 * the barrier-coverage and experiment-claim audits — sent back to Revise after
 * agreeing, with nothing to do but agree again. The standing rule in this file
 * is that the moment to raise a gap in a plan is before it is approved; after
 * that it is a limitation, stated, and the campaign still gets built.
 *
 * `reactionGap` is kept separate because `renderBuildSummary` leads with it:
 * a build that did not do what was agreed is reported in the first line or it
 * is not reported at all.
 */
export function confirmGaps(
  brief: WorkingBrief,
  blueprint: CampaignBlueprint | null,
  approved: Strategy | null,
): { lines: string[]; reactionGap: string | null } {
  if (!blueprint) return { lines: [], reactionGap: null };
  const lines: string[] = [];
  const coverage = checkBarrierCoverage(blueprint, mustBeAddressed(brief.barriers));
  for (const b of coverage.unaddressed) {
    lines.push(
      b.basis === 'user' || b.basis === 'user-belief'
        ? `You told me: ${b.statement} Nothing in this campaign does anything about it, so running it leaves the reason you gave untouched.`
        : `This campaign was designed around: ${b.statement} Nothing in it does anything about that.`,
    );
  }
  if (coverage.uncitedSends.length) {
    lines.push(
      `These messages do not say which problem they solve: ${coverage.uncitedSends.join(', ')}. A message that is not answering a known reason is just another contact.`,
    );
  }
  for (const v of checkExperimentClaims(blueprint)) lines.push(v.why);
  // IS THIS THE CAMPAIGN THEY WERE SOLD? `checkFidelity` compares the winner
  // the plan declared against what the steps actually do. It lived in the
  // build tail, which only a typed yes reached, so the button never asked.
  const learn = checkAudienceLearning(blueprint, mustLearnAudience(brief.converters));
  if (learn) lines.push(learn);
  const fid = checkFidelity(approved?.architectures, blueprint);
  if (fid && !fid.ok && fid.why) lines.push(fid.why);
  // AND THE BLOCKS A YES TURNS INTO LIMITATIONS. `decide(..., building: true)`
  // drops the plan-quality holds and keeps the record ones; on an approved
  // build they are costs to state, not reasons to refuse. Skipping them
  // silently would make the cost vanish on the one turn that produces a
  // campaign.
  for (const b of decide(brief, { building: true }).blocks) lines.push(b.reason);
  // THE CLAIM AGAINST THE STEPS, with no second model call. The retry this
  // replaced asked for a fork the manager had not approved and compiled the
  // clock anyway when it did not get one.
  const chosen = String((approved?.architectures ?? []).find((a) => a?.chosen)?.journey ?? '')
    .trim()
    .toLowerCase();
  const promised = chosen === 'branch-on-response' || chosen === 'wait-for-event';
  const reactionGap =
    promised && !journeyReacts(blueprint)
      ? 'The journey on the canvas is a timed sequence. The plan you approved said the next step would depend on whether each message was delivered, read or acted on, and nothing in what was built branches on that. A split by ticket size is segmentation, and the goal check after each send is the platform checking whether they converted, not the campaign reacting.'
      : null;
  return { lines, reactionGap };
}

/**
 * The plan and the path the manager actually approved: the FILED pair.
 *
 * WHY NOT THE CLIENT ECHO. The client posts `confirmedBlueprint` from its own
 * `pendingBlueprint` and `confirmedStrategy` from its own `pendingStrategy`,
 * and the Confirm path used to build both of those. That makes the browser a
 * second authority over what gets compiled: the record says one thing and the
 * echo can say another, and the echo was winning. `brief.lastProposal` is
 * written by `applyOutputTool` only when `propose_strategy` is ACCEPTED, so it
 * is the plan the application itself agreed to put up for approval.
 *
 * NO EQUALITY PREDICATE, deliberately. Comparing the echo to the record would
 * need a definition of "the same blueprint", and a deep-equal refuses honest
 * Confirms over key order or an edited description. The echo is simply not
 * read for the compile. The only refusal is the honest one: there is nothing
 * on file to build.
 */
export const approvedPair = (brief: WorkingBrief): { path: CampaignBlueprint | null; plan: Strategy | null } => {
  const filed = brief.lastProposal;
  const path = shapedBlueprint(filed?.blueprint as never) ? (filed?.blueprint as CampaignBlueprint) : null;
  return { path, plan: path ? ((filed?.strategy ?? null) as Strategy | null) : null };
};

export const toolResultBlock = (
  tool: string,
  id: string,
  applied: { error?: string; ok?: string },
  phase: TurnPhase,
): Record<string, unknown> => ({
  type: 'tool_result',
  tool_use_id: id,
  content:
    applied.error && tool === 'propose_strategy' && phase !== 'asking'
      ? `${applied.error}\n\n${PROPOSE_CORRECTION}`
      : applied.error ?? applied.ok ?? 'Recorded.',
  ...(applied.error ? { is_error: true } : {}),
});

const PROPOSE_CORRECTION =
  'Send the SAME plan again with that one thing fixed — do not start over and do not go back to discovery. Cite barriers by their recorded ids. Two architectures may cite the SAME barrier as long as they differ in entry, timing, lever or journey: with one barrier recorded that is the normal shape, and the rival is a different treatment of it, never a second invented reason.';

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
    } else if (!saysBuildNow(latestUserText) && objectiveChangedMaterially(brief.objective, latestUserText)) {
      // A TYPED CONFIRMATION IS NOT A NEW BRIEF. "Confirmed. Build this
      // campaign." shares almost no words with any objective, so it read as a
      // changed one: the approval was withdrawn and the machine reset to
      // `UNDERSTANDING_GOAL` on the very turn the manager said yes. The button
      // never hit this because the whole block is `intent === 'converse'`,
      // which is one more way the two doors were different products.
      // `saysBuildNow` is an exact match on that one sentence, so this cannot
      // swallow a real change of direction.
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
  // ONE CONFIRM, NOT TWO. This block used to build the client's ECHO and
  // return, skipping `checkBarrierCoverage`, `checkExperimentClaims` and the
  // reaction report — while a manager who TYPED the same sentence walked the
  // whole build tail and got a different campaign. It is now the single
  // Confirm door for both: it decides whether a yes may build, compiles
  // `approvedPair` — the plan and path on file — and returns. Nothing about a
  // Confirm reaches the tail below.
  //
  // AND IT DOES FIRE IN THE APP. An older comment here and in `server/CLAUDE.md`
  // said it could not, because a propose turn returned `pendingBlueprint:
  // null`. That was true when it was written. The slice that made the first
  // propose carry its journey set `pendingBlueprint` to the filed path, so the
  // client now posts a real echo and this is the Confirm-button path.
  // BOTH DOORS, ONE PATH. The button posts `intent: 'confirm'`; a manager who
  // types the same sentence posts only the sentence, and that used to walk a
  // completely different route — rounds, a forced `build_campaign`, a reaction
  // retry, and audits that could refuse the build after they had agreed.
  //
  // `AWAITING_STRATEGY_CONFIRMATION` is what keeps the typed half narrow: the
  // sentence is on screen in their own transcript, so it does get typed during
  // discovery, and nobody should be able to skip the gate by repeating it back.
  // FROM THE STATE THEY TYPED INTO, not the one this turn has already moved.
  //
  // `session` is reassigned above: the typed sentence shares almost no words
  // with the objective, so the changed-objective branch reads it as a new
  // brief and resets the machine to `UNDERSTANDING_GOAL`. Reading the local
  // here therefore made a typed yes impossible — measured, and the reason this
  // takes `req.session`, which is the state the plan was approved from.
  const typedYes =
    saysBuildNow(latestUserText) &&
    (req.session as SessionState | undefined)?.state === 'AWAITING_STRATEGY_CONFIRMATION';
  if (intent === 'confirm' || typedYes) {
    // The confirmation must be recorded against the plan that was ON SCREEN
    // when the user agreed. Stamping it with the CURRENT fingerprint first
    // would make the staleness check compare a value against itself and always
    // pass; that bug let a confirmation survive a changed objective.
    //
    // FROM THE FILED PAIR, not the echo. Same reason as the compile: the
    // browser must not be able to decide that a stale plan is fresh.
    const filedForStamp = approvedPair(brief);
    const confirmedFor = fingerprint(
      (filedForStamp.path?.description ?? '') + ' ' + (filedForStamp.plan?.summary ?? ''),
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
    // NOTHING ON FILE IS AN HONEST EMPTY, not a compile of whatever the
    // browser drew. The same family as a refused Plan: the record is settled,
    // the plan is not on file, and there is nothing to build.
    if (!approvedPair(brief).path) {
      em.emit('run.completed', 'strategy', 'No plan on file to build', { correlationId: 'run' });
      yield* drain();
      return {
        ...base,
        phase: 'planning',
        stage: 'proposed',
        reply:
          'There is no plan on file to build. The journey has to be sent as a plan before it can be confirmed, so nothing has been created. Ask for the plan again and it will come back as a path you can see.',
        questions: [],
        strategy: null,
        blueprint: null,
        pendingBlueprint: null,
        brief,
        session,
      };
    }
    em.emit('strategy.confirmed', 'generating', 'Strategy confirmed', {
      detail: 'Building the campaign with the application\'s own graph logic.',
    });
    yield* drain();
    session = { ...session, state: transition(session.state, 'GENERATING_CAMPAIGN') };
    // THE SAME COMPILE AS A TYPED YES: the filed pair, and the same reports.
    //
    // This door used to build `req.confirmedBlueprint` and skip
    // `checkBarrierCoverage`, `checkExperimentClaims` and the reaction report
    // entirely, while a manager who TYPED the same sentence got all three. Now
    // both doors read `approvedPair` and both report through
    // `confirmGaps` — the only difference left is that this one does not spend
    // a model round, because the path it compiles is already on file.
    const pair = approvedPair(brief);
    const gaps = confirmGaps(brief, pair.path as CampaignBlueprint, pair.plan);
    const out = buildAndValidate(
      req,
      tenant,
      bank,
      availableChannels,
      pair.path as CampaignBlueprint,
      pair.plan,
      em,
      gaps.reactionGap,
    );
    yield* drain();
    if (gaps.lines.length) {
      brief = recordApplicationVerdict(brief, { warnings: gaps.lines });
    }
    // ON THE DOCUMENT AS WELL AS THE RECORD. `renderStrategy` prints
    // `designWarnings` under "What this design cannot do", and a cost recorded
    // where nobody reads it is the same as dropping it.
    const confirmedStrategyOut = pair.plan
      ? { ...pair.plan, designWarnings: [...(pair.plan.designWarnings ?? []), ...gaps.lines] }
      : pair.plan;
    session = { ...session, state: transition(session.state, out.exportable ? 'EXPORT_ELIGIBLE' : 'CONFIGURATION_INCOMPLETE') };
    return {
      ...base,
      ...out,
      // THE MISMATCH LEADS, because `renderBuildSummary` leads with it. A
      // build that did not do what was agreed is reported in the first line or
      // it is not reported at all, and the blocker list follows the reply.
      campaignBlockers: [...((out.campaignBlockers as string[] | undefined) ?? []), ...gaps.lines],
      strategy: confirmedStrategyOut,
      phase: phaseAfterBuild(out),
      brief,
      session,
    };
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
  /**
   * Put a tool round and its results back on the conversation.
   *
   * EVERY `tool_use` GETS A RESULT, including one that was never applied: a
   * `tool_use` block with no matching `tool_result` is rejected outright, so a
   * missing one would lose the turn rather than correct it.
   */
  const appendToolExchange = (
    uses: { id: string; name: string; input?: Record<string, unknown> }[],
    outcomes: { tu: { id: string; name: string }; error?: string; ok?: string }[],
    phase: TurnPhase,
  ) => {
    conversation.push({
      role: 'assistant',
      content: uses.map((u) => ({ type: 'tool_use', id: u.id, name: u.name, input: u.input ?? {} })),
    });
    conversation.push({
      role: 'user',
      content: outcomes.map((o) => toolResultBlock(o.tu.name, o.tu.id, o, phase)),
    });
  };

  const phaseNow = (): TurnPhase => turnPhase(brief, { isBuildTurn, limitReached });
  const context = buildContextPrompt(req, brief, tenant, kbText, availableChannels, limitReached, isRefinement, phaseNow());

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
      // UNREACHABLE ON PURPOSE, and this is cleanup rather than one of the
      // defects this slice is about. The handshake asks the model to emit
      // `{"action":"design",...}` as prose before building, and `isBuildTurn`
      // was its ONLY gate — so the one turn it could fire on was Confirm. It
      // never has: nine recorded build turns contain no `action:"design"` and
      // no capability brief-back, because Confirm goes through the
      // `build_campaign` tool. The branch and `briefBackCapability` stay in the
      // file; `DESIGN_HANDSHAKE_LIVE` is what stops them spending a round on
      // the turn that compiles an approved plan.
      if (act === 'design' && !designSeen && peek.ok && isBuildTurn && DESIGN_HANDSHAKE_LIVE) {
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
      if (act === 'propose' && !designSeen && !designDemanded && isBuildTurn && DESIGN_HANDSHAKE_LIVE) {
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
          data: {
          tool: tu.name,
          kind: 'output' as const,
          // WHAT WAS SENT, ON THE FAILURE. `model.tool_call.requested` carries
          // the input; `failed` did not, so a refused `propose_strategy` was a
          // refusal with no body — `eval/runs/ui-s-1793017853714` turn 3 has
          // two of them and neither says what path was rejected. Only on a
          // failure, and only the steps, so a successful round does not double
          // the log for nothing.
          ...(applied.error ? { sent: (tu.input as { blueprint?: { steps?: unknown } } | undefined)?.blueprint?.steps ?? tu.input } : {}),
        },
        });
        yield* drain();
        // THE CORRECTION IS NOT WRITTEN HERE. `toolResultBlock` owns it, and
        // the forced propose below calls the same function — the two used to
        // carry a copy each.
        results.push(toolResultBlock(tu.name, tu.id, applied, phase));
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

    // PLAN IS NOT A QUESTIONNAIRE. One ready round that does not propose is
    // enough; the next call is the forced propose below.
    //
    // MEASURED, `eval/runs/ui-s-1793017853714` turn 3. The record was already
    // closed — ticket size retained, converters known, the barrier recorded.
    // Round 1 wrote `record_findings` and `record_dimensions` and then asked
    // about prior EMI in the bubble; round 2 was two hundred characters of
    // "tell me about prior EMI or I will go to the plan". Only then did
    // `readyWithNoJourney` fire, into a budget that had nothing left to
    // recover with.
    //
    // A ROUND OF LOOKUPS IS NOT THIS. Naming a real event, attribute or
    // channel is the work a ready turn is supposed to do before it commits to
    // one, so a round that only called `list_*` continues. A round that wrote
    // to the record, or wrote prose, without calling `propose_strategy` has
    // had its turn at asking.
    if (phase === 'ready' && !toolUses.some((t) => t.name === 'propose_strategy') && lookups < toolUses.length) {
      em.emit('model.completed', 'strategy', 'The record is settled; asking for the plan', {
        correlationId: `round-${round + 1}`,
        detail: 'This round recorded and did not put up a plan, so the plan is the next thing asked for.',
      });
      yield* drain();
      break;
    }
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
        data: {
          tool: tu.name,
          kind: 'output' as const,
          // WHAT WAS SENT, ON THE FAILURE. `model.tool_call.requested` carries
          // the input; `failed` did not, so a refused `propose_strategy` was a
          // refusal with no body — `eval/runs/ui-s-1793017853714` turn 3 has
          // two of them and neither says what path was rejected. Only on a
          // failure, and only the steps, so a successful round does not double
          // the log for nothing.
          ...(applied.error ? { sent: (tu.input as { blueprint?: { steps?: unknown } } | undefined)?.blueprint?.steps ?? tu.input } : {}),
        },
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

  // A READY TURN THAT SENT NO JOURNEY IS ASKED FOR ONE, exactly as Confirm is.
  //
  // MEASURED, `eval/runs/ui-s-1792991223125` turn 3. The record was finished —
  // count, ticket size, awareness, the probe closed with "not really" — and
  // `propose_strategy` was on the list. The agent called `record_findings` and
  // `record_dimensions`, then wrote "I've laid out the 7-day plan above". The
  // response was `revising` with `pendingBlueprint: null`: no Confirm, an
  // empty canvas, and a sentence claiming a journey that was never sent.
  //
  // THE SAME STRUCTURAL MOVE AS THE FORCED BUILD above, for the same reason:
  // the turn had one job, the job is a tool call, and the tool call did not
  // happen. `tool_choice` forces `propose_strategy`, the result goes through
  // `applyOutputTool` — the one boundary where model output becomes
  // application state — and NOTHING IS INVENTED. If it comes back with a
  // path, the ordinary propose path takes it (Approve, or Revise if a
  // plan-hold stands). If it comes back with nothing, the exits below say so
  // honestly rather than claiming a plan.
  //
  // Not on a build turn, which has its own forcing above, and not while the
  // record is open, where the job is to ask rather than to design.
  //
  // AND THE INSTRUCTION DOES NOT TEACH THE LIE. It used to add "do not say it
  // is above", which is this repo's standing mistake in miniature: prompt
  // wording against a failure the application can simply prevent. `closedReply`
  // is what stops the claim reaching the manager, so the sentence came out.
  const readyWithNoJourney =
    !isBuildTurn && phaseNow() === 'ready' && !toolBlueprint && !shapedBlueprint(brief.lastProposal?.blueprint as never);
  if (readyWithNoJourney) {
    const forcedStart = Date.now();
    em.emit('model.started', 'strategy', 'Asking for the plan itself', {
      status: 'running',
      correlationId: 'forced-propose',
      detail: 'The record is settled and the turn sent no plan. Asking for it directly.',
    });
    yield* drain();

    // ONE CORRECTION, THE SAME ONE AN UNFORCED PROPOSE ALREADY GETS.
    //
    // MEASURED, `eval/runs/ui-s-1792996412937` turn 3: the rounds filed
    // findings and wrote an essay, this block forced `propose_strategy`, the
    // model called it, and `applyOutputTool` refused it for having no journey.
    // The refusal named exactly what to fix — and it was emitted as an event
    // and thrown away, because nothing turned it into a `tool_result`. The
    // turn ended "No plan came back" with the Plan sentence and no Confirm.
    //
    // So a refused forced call is answered the way the round loop answers one:
    // the assistant's own `tool_use` goes back into the conversation, then a
    // `tool_result` carrying the error and `PROPOSE_CORRECTION`, and the tool
    // is forced once more.
    //
    // AT MOST ONE EXTRA CALL, and only for a refusal:
    //  - a first force that filed a shaped path is done;
    //  - a first force that sent NO tool call has already had its one ask, and
    //    asking again identically is how a loop gets built;
    //  - NOTHING IS INVENTED either time. No synthesised steps, no promoted
    //    prose. If the second apply still has no path, the Plan exits below
    //    say so.
    let totalCalls = 0;
    let corrected = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const forced: { id: string; name: string; input: Record<string, unknown> }[] = [];
      try {
        for await (const chunk of streamClaude({
          system: `${systemForPhase('ready')}\n\nYour previous turn recorded findings and did not put up a plan. The record is settled, so the plan is this turn's whole job: call propose_strategy NOW, with "touches" and with "blueprint" — the entry and then the steps in order. Only the tool call reaches the canvas.`,
          // The conversation, plus the refusal of the previous attempt once
          // there has been one. The addendum above is unchanged between the
          // two calls: the correction belongs in the tool result, where the
          // model reads it as the answer to what it just sent.
          messages: conversation,
          // The output tools only. `tool_choice` forces `propose_strategy`, so
          // a lookup could not fire even if it travelled, and the catalogue
          // has already been read in the rounds above — this is the same
          // conversation.
          tools: outputToolsForPhase('ready').map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
          toolChoice: { type: 'tool', name: 'propose_strategy' },
          disableThinking: true,
          maxTokens: 32000,
        })) {
          if (chunk.toolUse) forced.push(chunk.toolUse);
          // `usage` only, for the same reason as the forced build: the reply
          // the manager reads is whatever the model already wrote.
          if (chunk.done) usage = chunk.done.usage;
        }
      } catch {
        // Fall through with no plan. The exits below are honest about that.
        break;
      }
      totalCalls += forced.length;

      const outcomes: { tu: { id: string; name: string; input: Record<string, unknown> }; error?: string; ok?: string }[] = [];
      for (const tu of forced) {
        if (!isOutputTool(tu.name)) {
          outcomes.push({ tu, error: 'That tool is not available on this turn.' });
          continue;
        }
        const applied = applyOutputTool(brief, tu.name, tu.input);
        brief = applied.brief;
        if (applied.strategy) toolStrategy = applied.strategy;
        if (applied.blueprint) toolBlueprint = applied.blueprint;
        if (applied.openItems?.length) toolOpenItems = applied.openItems as OpenItem[];
        if (!applied.error) recordedViaTools = true;
        outcomes.push({ tu, error: applied.error, ok: applied.ok });
        em.emit(applied.error ? 'model.tool_call.failed' : 'model.tool_call.completed', 'strategy', toolTitle(tu.name), {
          status: applied.error ? 'failed' : 'ok',
          detail: applied.error ?? applied.ok,
          correlationId: tu.id,
          data: {
          tool: tu.name,
          kind: 'output' as const,
          // WHAT WAS SENT, ON THE FAILURE. `model.tool_call.requested` carries
          // the input; `failed` did not, so a refused `propose_strategy` was a
          // refusal with no body — `eval/runs/ui-s-1793017853714` turn 3 has
          // two of them and neither says what path was rejected. Only on a
          // failure, and only the steps, so a successful round does not double
          // the log for nothing.
          ...(applied.error ? { sent: (tu.input as { blueprint?: { steps?: unknown } } | undefined)?.blueprint?.steps ?? tu.input } : {}),
        },
        });
      }
      yield* drain();

      const refused = outcomes.find((o) => o.tu.name === 'propose_strategy' && o.error);
      const landed = shapedBlueprint(toolBlueprint as never);
      if (attempt > 0 || !refused || landed || !forced.length) break;

      // THE SAME APPEND THE ROUND LOOP MAKES, called rather than copied.
      appendToolExchange(forced, outcomes, 'ready');
      corrected = true;
      em.emit('model.started', 'strategy', 'Sending the correction back', {
        status: 'running',
        correlationId: 'forced-propose-again',
        detail: refused.error,
      });
      yield* drain();
    }

    em.emit('model.completed', 'strategy', toolStrategy ? 'The plan came back' : 'No plan came back', {
      correlationId: 'forced-propose',
      status: toolStrategy ? 'ok' : 'failed',
      durationMs: Date.now() - forcedStart,
      data: { toolCalls: totalCalls, forcedPropose: true, corrected },
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
  /**
   * REVISE REQUIRES A FILED PATH; otherwise the screen is Plan.
   *
   * MEASURED, `eval/runs/ui-s-1792991223125` turn 3: `revising` with
   * `pendingBlueprint: null` — no Confirm, an empty canvas, and the agent's
   * own sentence claiming the 7-day plan was "above". A Revise screen with
   * nothing to revise tells the manager a journey exists.
   *
   * One helper so the rule is stated once: every closed-record exit that has
   * no path to draw says `planning`, and `turnPhase` still reads `ready`, so
   * the plan tool is on the next call either way.
   */
  const planOrRevise = (path: unknown): 'planning' | 'revising' => (shapedBlueprint(path as never) ? 'revising' : 'planning');

  /**
   * WHAT A CLOSED-RECORD TURN SAYS, in one place.
   *
   * MEASURED, `eval/runs/ui-s-1792991223125` turn 3: "I've laid out the 7-day
   * plan above", on an empty canvas, because the journey was never sent. That
   * was stripped on ONE exit — the tools-and-prose one — and the others still
   * printed whatever the model wrote. Three doors, one lie.
   *
   * THE APPLICATION DECIDES FROM STATE, NEVER FROM WORDS. Nothing here matches
   * "laid out" or "above" or any other phrase: the test is a settled record
   * with no shaped path, which is exactly when a sentence about the plan
   * cannot be true. A model that writes something honest on a Plan turn loses
   * it too, and that is the right trade — the alternative is grepping prose
   * for claims, which cannot be maintained and would read the wrong sentence
   * first.
   *
   *  - `proposeRefused` WINS. A plan was written and one check turned it down;
   *    that is true, and more use than anything below it.
   *  - PLAN keeps the application's sentence. Their prose does not survive.
   *  - REVISE keeps their prose. A path is on file, so whatever they wrote is
   *    about a journey that exists.
   *
   * It does NOT decide the Brief screen, and it does not replace a hold: the
   * held door joins this to `renderBlocks` rather than instead of it, because
   * the block is the reason there is nothing to approve.
   */
  const PLAN_REPLY =
    'I have everything I need on the record. The plan itself has not gone up yet — that is the next thing I send you, as a journey you can see rather than a description of one.';
  const closedReply = (path: unknown, theirProse: string, refused: { summary: string } | null): string => {
    if (refused) {
      return [
        refused.summary ? `I have a plan ready — ${refused.summary}` : 'I have a plan ready.',
        'I could not put it up this turn because it did not pass one of my own checks, and I ran out of attempts to fix it. Tell me to go ahead and I will send it again.',
      ].join('\n\n');
    }
    return planOrRevise(path) === 'planning' ? PLAN_REPLY : theirProse.trim();
  };

  const proseBefore = (text: string): string => {
    const brace = text.indexOf('{');
    return (brace === -1 ? text : text.slice(0, brace)).trim();
  };

  /**
   * The same message with its enumerated tail removed.
   *
   * MEASURED, `eval/runs/ui-s-1792984906680` turn 1. The model asked three
   * things in prose — numbered, bolded, each with its reasoning — and the
   * response also carried the three as `questions`, which the client renders
   * as a numbered list under the bubble. The manager read the same ask twice.
   *
   * The list is what survives, because it is what the client gives an answer
   * box for. Everything before the first numbered line stays: "Three things I
   * need from you before I can design this properly:" is doing real work.
   *
   * TWO LINES MINIMUM, so a reply that happens to contain "1." in a sentence
   * is left alone, and only called where a list is actually going out.
   */
  const withoutNumberedTail = (text: string): string => {
    const lines = text.split('\n');
    const numbered = lines.map((l, i) => (/^\s*(\d+[.)]|[-*]\s*\*\*)/.test(l) ? i : -1)).filter((i) => i >= 0);
    if (numbered.length < 2) return text;
    return lines.slice(0, numbered[0]).join('\n').trim();
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
    const askedThisTurn = (brief.questions ?? [])
      .filter((q) => !questionIdsBefore.has(q.id))
      .slice(0, MAX_QUESTIONS_PER_ROUND);
    // EMPTY QUESTIONS ARE UNREPRESENTABLE WHILE THE RECORD IS OPEN.
    //
    // MEASURED, `eval/runs/ui-s-1792989364193` turn 2. The manager answered
    // the three brief questions. The agent called `record_findings` and
    // `record_dimensions`, wrote "Everything I need is now on record", and
    // never asked the probe. This branch returned that sentence with
    // `questions: []`. `decide(brief)` was `unprobed-other-axes` — the
    // activity line even said "Waiting for your answer" — and the answer
    // never reached the screen, because the fill-from-blocks path lived only
    // on a held propose.
    //
    // So this is the Brief screen: the application's questions, on the
    // response AND on the record (or the next reply cannot close them). The
    // model's completeness sentence is not the reply; it is the thing this
    // branch used to print instead of the ask.
    if (!gateNow.proceed && !askedThisTurn.length) {
      const briefQuestions = gateNow.blocks.slice(0, 3).map((b) => b.reason);
      const delta = blockDelta(gateNow.blocks, brief.lastBlocks ?? []);
      brief = recordQuestions(brief, briefQuestions);
      brief = { ...brief, lastBlocks: gateNow.blocks.map((b) => b.code) };
      session = {
        ...session,
        state: transition(
          session.state === 'DISCOVERING' ? session.state : transition(session.state, 'DISCOVERING'),
          'AWAITING_USER_ANSWER',
        ),
      };
      em.emit('run.completed', 'discovery', 'Waiting for your answer', { correlationId: 'run' });
      yield* drain();
      return {
        ...base,
        phase: 'discovery',
        stage: 'discovery',
        // THE ASK ALONE, and the completeness sentence is NOT kept.
        //
        // I tried keeping their prose here with its enumerated tail stripped,
        // the way the held Brief screen does, on the principle that the
        // model's own words are the better copy. It is the wrong call on this
        // one exit, for a reason specific to it: the sentence is FALSE.
        // "Everything I need is now on record" is contradicted by the record
        // in the same breath — the probe is open — and printing a false claim
        // and then correcting it one paragraph later is worse than not
        // printing it. Same shape as the held propose turn, where the prose
        // alone announced a plan the gate had just refused.
        reply: renderBlocks(delta, gateNow.advice),
        questions: briefQuestions,
        brief,
        session,
        strategy: null,
        blueprint: null,
        discoveryRounds: brief.rounds,
      };
    }
    em.emit('run.completed', 'discovery', gateNow.proceed ? 'Ready to propose' : 'Waiting for your answer', {
      correlationId: 'run',
    });
    yield* drain();
    return {
      ...base,
      // AND THE CLOSED HALF OF THE SAME EXIT. The branch above handles an
      // open record; this one is reached when the record is SETTLED and the
      // turn still produced only tool writes and prose. `discovery` there
      // said "waiting for your answer" to a manager with nothing left to
      // answer — and hid any journey already on file, because the client
      // draws on a plan phase. `askedThisTurn` is empty on a closed record by
      // construction: `ask_questions` is not on a ready turn's tool list.
      phase: gateNow.proceed ? planOrRevise(brief.lastProposal?.blueprint) : 'discovery',
      stage: gateNow.proceed ? 'proposed' : 'discovery',
      pendingBlueprint: shapedBlueprint(brief.lastProposal?.blueprint as never)
        ? (brief.lastProposal?.blueprint as never)
        : null,
      // NEVER "Recorded." AFTER A PROPOSAL WAS ATTEMPTED.
      //
      // The agent had written a plan; the application refused it on a rule
      // that has since been fixed, and then told the manager the turn had
      // produced a filing note. Whatever else is true, a turn that tried to
      // propose did not merely record.
      // AND ON PLAN, THEIR PROSE DOES NOT SURVIVE EITHER.
      //
      // MEASURED, `eval/runs/ui-s-1792991223125` turn 3: "I've laid out the
      // 7-day plan above." Nothing was laid out anywhere — the journey was
      // never sent, and the forced `propose_strategy` above did not produce
      // one. Printing that sentence tells the manager to look for a canvas
      // that is empty, which is the same false-claim problem as the
      // completeness essay on the Brief screen.
      //
      // So a Plan turn says what is true: the record is settled and the plan
      // has not gone up yet. With a path on file (Revise) the prose is kept —
      // there, whatever they wrote is about a journey that genuinely exists.
      // A REFUSED PROPOSE WINS, and getting that order wrong was a regression
      // of mine: a plan WAS written and one check turned it down, which is
      // both true and more use to the manager than anything below it.
      // ONE RULE, SHARED. `closedReply` decides refused / Plan / Revise; this
      // exit was the only one that had it, inline, and the others printed the
      // claim.
      reply:
        (gateNow.proceed
          ? closedReply(brief.lastProposal?.blueprint, prose, proposeRefused)
          : askedThisTurn.length
            ? withoutNumberedTail(prose)
            : prose) || 'Recorded.',
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
      //
      // AND WHEN THAT LIST IS NON-EMPTY the prose above loses its enumerated
      // tail — see the `reply` field. Live turn 1 asked through
      // `ask_questions` and then restated the same three as numbered prose,
      // which reaches this exit with `askedThisTurn` set: full prose kept, and
      // the client listing the same questions underneath.
      questions: askedThisTurn.map((q) => q.text),
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
      // THE SAME SPLIT, because this is the same lie in a quieter place. An
      // answer the parser could not read is still a turn, and this returned
      // `phase: 'discovery'` with no `questions` field at all — so on an open
      // record the manager got readable prose and nothing to do, and on a
      // closed one they were put back on Brief with a finished brief.
      const openNow = !decide(brief, { proceedRequested: limitReached }).proceed;
      const blocksNow = decide(brief).blocks;
      const askNow = openNow ? blocksNow.slice(0, 3).map((b) => b.reason) : [];
      if (askNow.length) brief = recordQuestions(brief, askNow);
      em.emit('run.completed', 'discovery', openNow ? 'Waiting for your answer' : 'Waiting on the plan', {
        correlationId: 'run',
      });
      yield* drain();
      return {
        ...base,
        phase: openNow ? 'discovery' : planOrRevise(brief.lastProposal?.blueprint),
        stage: openNow ? 'discovery' : 'proposed',
        // OPEN: their prose minus the enumerated tail, then the ask. CLOSED:
        // the shared rule, so a claim about a plan that does not exist dies
        // here too — this exit printed `prose` whatever the state was.
        reply: openNow
          ? [withoutNumberedTail(prose), askNow.length ? renderBlocks(blockDelta(blocksNow, brief.lastBlocks ?? []), []) : '']
              .filter(Boolean)
              .join('\n\n')
          : closedReply(brief.lastProposal?.blueprint, prose, proposeRefused),
        questions: askNow,
        // A path already on file is drawn rather than forgotten, which is what
        // `revising` is for.
        pendingBlueprint: shapedBlueprint(brief.lastProposal?.blueprint as never)
          ? (brief.lastProposal?.blueprint as never)
          : null,
        brief,
        session,
        strategy: null,
        blueprint: null,
      };
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
  const rawProposed =
    toolStrategy !== null
      ? { action: 'propose' as const, strategy: toolStrategy, blueprint: toolBlueprint ?? undefined, openItems: toolOpenItems }
      : parsed.value.action === 'propose'
        ? parsed.value
        : null;

  // THE CLAIM IS ALIGNED TO THE STEPS ONCE, HERE, so every reader downstream
  // sees the plan the manager would approve rather than the label the model
  // typed: the gate, the option audit, fidelity, `renderStrategy`, and the
  // strategy that goes back to the client. `decide` aligns internally too —
  // it has to, because tests and replays call it directly — and the function
  // is idempotent, so a plan that was already honest passes through
  // untouched.
  //
  // BOTH PATHS GO THROUGH IT. The tool path and the JSON path assemble
  // different objects, and a repair on only one of them is how a false claim
  // would reach a manager's screen on the other.
  const aligned = alignJourneyClaim(rawProposed as never);
  const proposed = (aligned.proposed ?? null) as typeof rawProposed;
  // `aligned.advice` is NOT read here. `decide` runs the same alignment on the
  // same proposal and merges those sentences into `decision.advice`, which is
  // what `renderBlocks` and the propose reply already print. A second copy
  // would say it twice.

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

  // HOISTED ABOVE THE GATE, 2026-10-26. It used to be computed 110 lines
  // below the two `gate.outcome` returns, so both of those answered "the
  // record is open" without anyone having asked. `phaseNow()` reads the
  // record and nothing else — the same answer `turnPhase` gives the tool
  // list — so the plan checks cannot move it.
  const briefClosed = phaseNow() !== 'asking';
  const gate = evaluateDiscovery({
    appOpenItems,
    briefClosed,
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

  // COMMENTARY CANNOT REOPEN THE BRIEF, and these two returns are the doors
  // it came through. Each sets `phase: 'discovery'` — `request_evidence` with
  // `questions: []`, `ask_questions` with a numbered list — and each fired
  // before the Brief/Revise split existed, so a leftover thought reached the
  // screen as question 1 beside an approvable plan.
  //
  // `evaluateDiscovery` now refuses to return either outcome on a closed
  // record (it takes `briefClosed` above), so these guards are the second
  // half of the same rule, kept explicit because a future outcome could reach
  // them the same way.
  if (!briefClosed && gate.outcome === 'request_evidence') {
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

  if (!briefClosed && gate.outcome === 'ask_questions') {
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
      // THE LIST IS THE ASK, so the rationale loses any enumerated tail.
      //
      // MEASURED, turn 1 of `eval/runs/ui-s-1792984906680`: the model asked
      // three things through the tool AND wrote the same three as numbered
      // prose, so the manager read them twice — once in the bubble, once in
      // the client's numbered list under it. `withoutNumberedTail` keeps the
      // lead-in ("Three things I need from you before I can design this
      // properly:") and drops the enumeration, and only ever runs when a list
      // is actually going out.
      reply: withoutNumberedTail(
        ((parsed.value.action === 'ask' ? parsed.value.rationale : gate.reason) ??
          'A few questions before I design this.') as string,
      ),
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
  // TWO QUESTIONS, NOT ONE BIT.
  //
  // `decision.proceed` answers "is the brief closed?" AND "may this proposal
  // be approved?" at once, and this branch used to dump both into
  // `discovery` with the gate's questions. MEASURED,
  // `eval/runs/ui-s-1792984906680` turns 3 and 4: the record was finished
  // (`decide(brief).blocks` empty), a real journey was on file, and the
  // manager read "Waiting for your answer" with no question and no button.
  // Brief-open, plan-held and "the model wrote an essay" were all one screen.
  //
  // `briefClosed` is the record's own answer — the same input `turnPhase`
  // uses, so the plan tool stays on the next turn whatever the plan checks
  // say. What is left after that is a change to the PLAN, which is a
  // different screen with a different reply and no questions at all.
  if (!decision.proceed && !approvedPlan) {
    brief = briefClosed ? brief : recordQuestions(brief, withImpact(gate.questions));
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
    // ONE ASK, NOT TWO COPIES OF IT.
    //
    // MEASURED, turn 1 of the same run. The model wrote its three questions
    // as prose — numbered, bolded, with the reasoning for each — and the
    // response ALSO carried the three as `questions`, which the client renders
    // as a numbered list underneath. The manager read them twice.
    //
    // The model's wording is the better copy, so the LIST is what survives and
    // the restatement is cut: everything up to the first numbered line stays
    // (the lead-in sentence is doing real work), the enumerated tail goes.
    // Only when a list is actually going out, and only on the Brief screen.
    // HOISTED, because the reply has to know whether there is a path before it
    // decides whose words lead. Same value the response carries below.
    const filedPathForReply = shapedBlueprint(proposed?.blueprint ?? null)
      ? proposed?.blueprint ?? null
      : shapedBlueprint(brief.lastProposal?.blueprint as never)
        ? (brief.lastProposal?.blueprint as never)
        : null;
    const heldProse = proseBefore(assistantText).trim();
    // `decision.advice` already carries the journey sentences — `decide`
    // aligns the same proposal and merges them — so they are not appended a
    // second time here.
    const briefQuestions = briefClosed
      ? []
      : gate.questions.length
        ? gate.questions
        : // NEVER AN EMPTY ASK WHILE THE RECORD IS OPEN. The blocks each name
          // the thing that is missing, in the manager's own terms, and
          // `renderBlocks` is already saying them — but the client's question
          // list is what it offers an answer box for.
          decision.blocks.slice(0, 3).map((b) => b.reason);
    const prose = briefQuestions.length ? withoutNumberedTail(heldProse) : heldProse;
    // THE HOLD IS THE POINT OF THIS TURN, and the Plan sentence does not
    // replace it.
    //
    // This door is reached when they sent something the gate refused — a
    // caption-only propose, a claimed reaction with no fork — so the BLOCK is
    // why there is nothing to approve, and `renderBlocks` names the mutation
    // that clears it. Swapping the whole reply for "the plan has not gone up
    // yet" would be a polite dead end: true about the canvas, silent about
    // the one thing the model has to change.
    //
    // What the Plan rule does take is their CLAIM. On a closed record with no
    // shaped path, prose about the plan cannot be true, so the lead paragraph
    // becomes the application's sentence and the hold follows it. With a path
    // on file (Revise) their prose stays, because the journey exists.
    const planLead = briefClosed && planOrRevise(filedPathForReply) === 'planning';
    const reply = [planLead ? PLAN_REPLY : prose, renderBlocks(delta, decision.advice)]
      .filter(Boolean)
      .join('\n\n');

    brief = { ...brief, lastBlocks: decision.blocks.map((b) => b.code) };
    // A FILED PATH STILL REACHES THE CLIENT, so the manager can see what is
    // being discussed while the gate holds for some OTHER reason.
    //
    // MEASURED, `eval/runs/ui-s-1792843757296` turn 3. `propose_strategy` had
    // accepted a real journey onto `brief.lastProposal` — ticket-size branch,
    // experiment, an outcome fork on READ against DELIVERED/DELETED — and this
    // branch returned `pendingBlueprint: null`, so `previewFromBlueprint` had
    // nothing to draw and the manager read an essay about a journey they could
    // not see. The preview was written for exactly this turn and had never
    // once been given anything.
    //
    // `strategy` and `blueprint` stay null and `graph` stays null, which is
    // the line that matters: nothing is approved and nothing is built. This is
    // a drawing of a proposal, and Confirm is still the act that accepts it.
    // The phase here is `revising`, or `planning` when there is no path to
    // draw, or `discovery` while the record is open — never the approval
    // phase, so the button cannot appear from this branch. (Named in words:
    // several tests slice this region and assert that the approval phase's
    // own string does not appear in it.)
    const filedPath = filedPathForReply;
    return {
      ...base,
      // REVISE IS NOT "DISCOVERY CONTINUES". The brief is closed; what is open
      // is the journey. No questions, no Confirm, and the path is drawn — or
      // `planning` when there is no path on file, because Revise with nothing
      // to revise tells the manager a journey exists.
      phase: briefClosed ? planOrRevise(filedPath) : 'discovery',
      stage: briefClosed ? 'proposed' : 'discovery',
      reply,
      questions: briefQuestions,
      strategy: null,
      blueprint: null,
      pendingBlueprint: filedPath,
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
  // THEY ONLY ASKED, AND THE RECORD IS CLOSED. Not an error, and not Brief.
  //
  // With both doors shut above, a turn whose only output was questions used to
  // fall through to the failure below — "The agent did not produce a strategy.
  // Retry to force a proposal." That error is worse than the door it
  // replaces: the brief is finished, the asks are commentary, and there may
  // already be a journey on file from an earlier turn.
  //
  // So: no numbered list, the path drawn if one exists, and the phase from
  // `planOrRevise` — `revising` with a filed path, `planning` without one,
  // because Revise with nothing to revise is the lie `revising` was
  // introduced to kill. With a path their own prose survives; on Plan it is
  // replaced, because a sentence about a journey that was never sent points
  // the manager at an empty canvas. `turnPhase` still reads `ready` next turn
  // either way, so `propose_strategy` is on the list for the plan they now
  // have to send.
  if (!proposed && briefClosed) {
    const filed = shapedBlueprint(brief.lastProposal?.blueprint as never)
      ? (brief.lastProposal?.blueprint as never)
      : null;
    em.emit('run.completed', 'strategy', filed ? 'Waiting on a change to the plan' : 'Waiting for the plan', {
      correlationId: 'run',
    });
    yield* drain();
    const asked = gate.openItems.map((i) => i.question).filter(Boolean);
    return {
      ...base,
      phase: planOrRevise(filed),
      stage: 'proposed',
      // SHARED RULE, and this door is how a JSON `{ action: 'ask' }` lands on
      // a ready turn — `ask_questions` is off the ready tool list, but JSON in
      // the message is not. Their rationale is exactly where a claim about the
      // plan arrives, so Plan replaces it and Revise keeps it. The phase is
      // `planOrRevise(filed)`, not a flat `revising`.
      reply:
        closedReply(filed, proseBefore(assistantText), proposeRefused) ||
        [
          'Those points do not change what the plan is, so I have recorded them against it rather than putting them to you as questions.',
          ...asked.slice(0, 3).map((q) => `- ${q}`),
        ].join('\n'),
      // NOT A QUESTIONNAIRE. These are flags on the document; the client
      // renders `questions` as a numbered list with an answer box, and a
      // closed brief has nothing it is waiting to be told.
      questions: [],
      strategy: null,
      blueprint: null,
      pendingBlueprint: filed,
      discoveryRounds: brief.rounds,
      brief,
      session,
      usage,
    };
  }

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

  // THIS TURN'S JOURNEY, and on this path that is the only honest source.
  //
  // A Confirm compiles `approvedPair` at the door above and returns, so what
  // reaches here is a REFINEMENT: the manager asked for a specific change, and
  // the journey the model just produced is the point. `brief.lastProposal` is
  // not the journey they asked to change, and `req.confirmedStrategy` is the
  // browser's echo of the plan that was approved BEFORE the change — reading
  // either here would re-open the second authority this slice closed.
  //
  // `let` because `applyAudit` rebuilds the strategy below. Nothing replaces
  // the blueprint after this point.
  let { blueprint } = proposed;
  const approvedBase = proposed.strategy ?? null;


  // ONE REPORT ON EVERY APPROVED BUILD, from the one function.
  //
  // `confirmGaps` is the single definition of what a yes is TOLD — barrier
  // coverage, experiment claims, audience learning, fidelity, and the blocks
  // the gate still raises — and it returns the reaction sentence rather than a
  // second copy of it. The Confirm door calls it; so does this one. A
  // refinement that compiled an uncited send used to do it silently, because
  // the refusal below is skipped once a plan is approved and nothing replaced
  // it.
  //
  // THIS TURN'S PLAN, NOT THE FILED ONE. A refinement is a change to the
  // journey, so the claim to check is the one the model just made.
  const tailGaps = approvedPlan
    ? confirmGaps(brief, (blueprint ?? null) as CampaignBlueprint | null, approvedBase)
    : { lines: [] as string[], reactionGap: null as string | null };
  const reactionGap = tailGaps.reactionGap;

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
  // campaign gets built.
  //
  // `approvedBase` IS this turn's plan on this path, because a Confirm no
  // longer reaches it — the only build turn left here is a refinement, where
  // the claim to compare against is the one the model just made.
  const architectureComparison = compareArchitectures(approvedBase?.architectures);
  const fidelity = checkFidelity(approvedBase?.architectures, blueprint);
  // An experiment whose arms run the same journey can test wording and nothing
  // more. Folded into the comparison verdict rather than given its own field:
  // it is the same finding — alternatives that are not really alternatives.
  const copyOnly = copyOnlyExperiments(blueprint);
  let strategy = approvedBase
    ? {
        ...approvedBase,
        strategyOptions: applyAudit(approvedBase.strategyOptions, optionAudits),
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
  // A PROPOSE TURN CARRIES THE PATH AND BUILDS NOTHING.
  //
  // THE OLD SENTENCE HERE SAID THE OPPOSITE — "a propose turn carries no
  // blueprint, by design" — sitting directly above a return that sends one.
  // That was true until the plan started carrying its path, and a stale
  // contract on the line that implements it is worse than no comment: the
  // next reader trusts it.
  //
  // What survives from it is the principle it was protecting, and that is
  // unchanged: the plan is agreed in BUSINESS terms, and the builder's
  // vocabulary is withheld until the record supports a proposal. What the
  // manager approves is the sequence, so the sequence travels — as
  // `pendingBlueprint`, which the left pane draws and the client posts back.
  //
  // NOTHING IS BUILT HERE. No graph, no validation, no campaign: `blueprint`
  // on the response is the proposed path, not a compiled one, and Confirm is
  // still the act that compiles it.
  //
  // The structural checks that read a journey (barrier coverage, whether the
  // campaign can learn who converts, whether an experiment can settle its own
  // claim) stay on the build turn. They check what was BUILT, and on this
  // turn nothing has been.
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
      // THE ADVICE GOES BESIDE THE BUTTON, NOT ONLY INTO A HELD TURN.
      //
      // MEASURED. `alignJourneyClaim` puts `READ_FORK_ADVICE` on
      // `decision.advice` when the steps are a clock, and the rival sentence
      // when they wrote both candidates and picked the calendar. The HELD
      // branch prints that list — `renderBlocks(delta, decision.advice)` —
      // and this return, the one a manager actually sees Confirm on, did not
      // receive it at all. So a who-split clock that is allowed through, which
      // is now the common case, reached Confirm with nothing said about what
      // a read-fork would have added.
      //
      // JOINED AFTER `renderStrategy`, not folded into it. That function
      // writes the strategy document — the plan, the options table, the open
      // items — and advice is none of those: it is not an open item, not a
      // question, and not a block. One paragraph after the document, in the
      // same sentences the held path already uses.
      //
      // NOT ON THE BUILD TURN'S `replyText`. That run happens after they
      // pressed Confirm, and telling someone what would have been smarter
      // about a campaign they have just approved is a cost with no decision
      // left to spend it on.
      reply: [
        renderStrategy(
        strategy,
        gate.openItems,
        undefined,
        brief.questionResolutions ?? [],
        brief.questions,
        unsupportedClaims(optionAudits),
      ),
        ...decision.advice,
      ]
        .filter((part) => String(part ?? '').trim())
        .join('\n\n'),
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
    // THE SAME REPORT THE CONFIRM DOOR MAKES. Deduped, because this path has
    // its own fidelity and limitation handling above and `confirmGaps` covers
    // the same ground — a cost stated twice reads as two costs.
    const already = new Set([...(out.campaignBlockers ?? []), ...(strategy?.designWarnings ?? [])]);
    const extra = tailGaps.lines.filter((l) => !already.has(l));
    if (extra.length) {
      brief = recordApplicationVerdict(brief, { warnings: extra });
      out.campaignBlockers = [...(out.campaignBlockers ?? []), ...extra];
      strategy = strategy ? { ...strategy, designWarnings: [...(strategy.designWarnings ?? []), ...extra] } : strategy;
    }
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
    return { ...base, ...out, phase: phaseAfterBuild(out), brief, session, usage };
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
  // NOT A REFUSAL AFTER YES. Both of these used to send a manager who had
  // already approved the plan back to Revise, with nothing to do but approve
  // again — the mistake this file records twice already, under "two guards
  // that spoke for the manager". On an approved build the finding is reported
  // by `confirmGaps` and the campaign is still compiled.
  const coverage = checkBarrierCoverage(blueprint, mustBeAddressed(brief.barriers));
  if (!approvedPlan && (coverage.uncitedSends.length || coverage.unaddressed.length)) {
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
    em.emit('run.completed', 'strategy', 'Reworking the campaign', { correlationId: 'run' });
    yield* drain();
    return {
      ...base,
      // REVISE, NOT BRIEF. A plan existed and one of its own checks refused
      // it; the record is not in question. `discovery` here told a manager
      // whose brief was finished that discovery was continuing, and the
      // client hid the journey because the phase was not a plan phase.
      phase: 'revising',
      stage: 'proposed',
      reply: ['I need to rework this before showing it to you.', '', ...why].join('\n'),
      questions: [],
      // The path that was refused is still what is being talked about.
      pendingBlueprint: shapedBlueprint(blueprint as never) ? (blueprint as never) : null,
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
  if (!approvedPlan && claimViolations.length) {
    brief = recordApplicationVerdict(brief, {
      warnings: claimViolations.map((v) => v.why),
    });
    session = { ...session, state: transition(session.state === 'DISCOVERING' ? session.state : transition(session.state, 'DISCOVERING'), 'AWAITING_USER_ANSWER') };
    em.emit('validation.started', 'strategy', 'Experiment cannot answer its own question', {
      status: 'failed',
      detail: claimViolations.map((v) => v.label).join('; '),
      data: { violations: claimViolations },
    });
    em.emit('run.completed', 'strategy', 'Reworking the experiment', { correlationId: 'run' });
    yield* drain();
    return {
      ...base,
      // REVISE. The experiment's own claim does not hold up, which is a
      // change to the PLAN. The "which way do you want it" sentence below is
      // a plan choice and stays in the document — it is not a discovery
      // question, and Confirm stays off because nothing is approvable yet.
      phase: 'revising',
      stage: 'proposed',
      pendingBlueprint: shapedBlueprint(blueprint as never) ? (blueprint as never) : null,
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
  // HISTORY, AND IT NO LONGER DESCRIBES THIS CODE. This block was added when a
  // propose turn returned `pendingBlueprint: null`: the client then posted
  // `confirmedBlueprint: null`, missed the confirm short-circuit, landed here,
  // produced a blueprint and returned `awaiting-confirmation` with the copy the
  // manager had just answered — so they pressed Confirm twice. A propose turn
  // carries its path now and both yeses return at the door, so none of that is
  // reachable. What is left below is the rule the block still earns: a turn
  // that is allowed to build goes through generation and then builds.
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
    // WHO STILL LANDS HERE, and it is not a refinement — those return at the
    // `isRefinement` block above.
    //
    // Exactly one case reaches this: someone who TYPES "Confirmed. Build this
    // campaign." while `req.session` is not `AWAITING_STRATEGY_CONFIRMATION`.
    // That sentence is on screen in their own transcript, so it does get typed
    // at other moments, and `isBuildTurn` counts it while the Confirm door
    // does not — the door requires the state a plan was actually approved
    // from. `approvedPlan` is false for that case too, which is why the
    // report the door and the refinement both make is NOT repeated here: it
    // would have nothing to add.
    session = { ...session, state: transition(session.state, 'GENERATING_CAMPAIGN') };
    const out = buildAndValidate(req, tenant, bank, availableChannels, blueprint, strategy, em, reactionGap);
    // NO SECOND REPORT HERE. `confirmGaps` is merged on the Confirm door and on
    // the refinement compile, which are the two paths a yes can take. The only
    // turn that reaches this one has `approvedPlan` false, so `tailGaps` is
    // empty and a merge could not add a line — and a merge that cannot fire
    // reads as a third place where this is handled.
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
    return { ...base, ...out, phase: phaseAfterBuild(out), brief, session, usage };
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
 * The phase a completed build turn returns.
 *
 * ONE DEFINITION, because all three callers had `out.stage === 'error' ?
 * 'error' : 'review'` written out, and `'blocked'` maps to review as happily
 * as `'proposed'` does. A build that produced no message steps therefore
 * reached the manager as a review screen over a canvas of exits.
 *
 * `revising` is the honest screen for that: the plan is still on file, and
 * what the compiler made of it is not something to approve. Confirm is off
 * there, and the preview draws the filed path rather than the exits.
 */
function phaseAfterBuild(out: { stage: Stage; graph?: unknown }): Phase {
  if (out.stage === 'error') return 'error';
  return out.graph ? 'review' : 'revising';
}

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

  // A CANVAS OF EXITS IS NOT A CAMPAIGN, AND THE DOOR MUST NOT CALL IT ONE.
  //
  // MEASURED, `eval/runs/ui-s-1793009889177` turn 5. Confirm compiled the
  // filed path, every send was skipped, and the response came back
  // `phase: 'review'` with a graph holding an entry, a split and three exits.
  // The reply said plainly that no message steps were produced — and the
  // manager was shown a review screen with that canvas on it.
  //
  // Decided here rather than at the call site, because all three callers map
  // anything that is not `error` to `review`, and a refinement would otherwise
  // ship the same empty exits. No send means no graph to draw.
  const builtSends = Object.values(built.graph.nodes).filter((n) => (n as { type?: string }).type === 'SEND').length;

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
    reply: renderBuildSummary(strategy, built, validation, unresolvedSends.length, exportable, reactionGap, blueprint),
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
    // LAST, SO IT WINS. Nothing to draw, so nothing is drawn — see
    // `builtSends` above, and `phaseAfterBuild`, which reads the graph rather
    // than the stage. Placed before `graph: built.graph` the first time, where
    // the later key quietly overrode it and the exits still reached the screen.
    ...(builtSends === 0 ? { graph: null, campaign: null, designGenerated: false, exportable: false } : {}),
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
  /**
   * The filed path Confirm compiled. Density is read from its steps, not from
   * `touches[].path` labels — those names split one customer route across
   * several rows (MEASURED, `eval/runs/ui-s-1793086620956` turn 4: 2 vs 3).
   */
  approvedPath: CampaignBlueprint | null = null,
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
  // THE STEPS ARE THE PLAN. Nested engagement arms are one route with several
  // labels in `touches`; grouping those labels under-counts the fullest path.
  // `longestSendSteps` walks the same JSON Confirm compiled.
  const plannedDensity = approvedPath
    ? longestSendSteps(approvedPath.steps as unknown[])
    : Math.max(0, ...byPathCount.values());
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
  /**
   * WHICH TURN THIS IS, from `turnPhase`. `isBuildTurn` WAS a parameter beside
   * it, read by the three per-phase blocks that are now gone. One fact about
   * the turn, not two: `phase === 'build'` is the same question.
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
    // THE STICKY IS NOT HERE ANY MORE, and that is the fix rather than a
    // tidy-up. This context message is built once per send and pushed onto
    // `conversation`; the tool list and the method prompt are rebuilt every
    // ROUND from `phaseNow()`. A send that starts on an asking turn and closes
    // the record with `record_findings` therefore gave round two Plan tools
    // and a Discovery sticky. `systemForPhase` carries it now, so the job and
    // the tools always describe the same turn.
    '',
    '# This issuer',
    issuerContext(availableChannels, tenant.templateLibraryAccess),
    '',
    // NO SECOND SET OF JOBS. Three per-phase blocks used to sit here — "NO
    // BLUEPRINT THIS TURN", "THE PLAN YOU PUT UP MUST CARRY ITS PATH" and
    // "THIS TURN BUILDS THE APPROVED PLAN" — and each one restated, in
    // different words, what that phase's sticky already says. The asking one
    // was worse than redundant: it told a discovery turn to describe the
    // journey in "strategy.approach" and called that description "the
    // deliverable this turn", on a turn where `propose_strategy` is not even
    // on the tool list. That is the same shape as the five identical refusals
    // in `ui-s-1792834072700` — the application asking for a thing it will not
    // accept.
    //
    // THE CATALOGUE IS STILL NOT PASTED, and that is the other half of this.
    // Every event name and attribute list used to be glued in here on any turn
    // that might design; gating the lookup TOOLS did nothing while the terms
    // were already in the first user message. The turns that write steps get
    // the lookups, and nobody gets the paste. `issuerContext` above stays on
    // every turn, because which channels this issuer has is bank context and
    // shapes a strategy.
    //
    // ALSO GONE WITH THE BUILD BLOCK: the {"action":"design",...} intervention
    // handshake. It has never fired on a live Confirm — nine recorded build
    // turns, none of them with an `action:"design"` or a capability
    // brief-back, because Confirm goes through the `build_campaign` tool. The
    // `act === 'design'` branch and `briefBackCapability` are left in place
    // and are now unreachable from the prompt; that dead branch is logged as
    // its own finding rather than removed in this slice.
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
    // THE DISCOVERY BUDGET IS A DISCOVERY FACT, AND IT WAS PHASE-BLIND.
    //
    // Keyed on `limitReached` alone, so an ASKING turn read "If the brief is
    // already clear enough, propose instead" while `propose_strategy` was not
    // on its tool list, and a CONFIRM turn was handed a discovery budget it
    // has no use for. Both are the application contradicting itself; the
    // asking one is the exact sentence that made a live run ask the manager to
    // type "go ahead".
    //
    //  - asking: the round count, and nothing about proposing.
    //  - ready: proposing IS the job, so both forms belong here.
    //  - build: neither. Confirm is not a discovery budget.
    phase === 'build'
      ? ''
      : phase === 'ready'
        ? limitReached
          ? `# DISCOVERY LIMIT REACHED (${req.discoveryRounds}/${MAX_DISCOVERY_ROUNDS}). Put the plan up now. Every dimension still "open" must leave the record as a decision, not a silence: give it status "deferred" or "unavailable" with a note, and carry it into strategy.assumptions where it is safe to assume one, or strategy.unknowns plus a stated limitation where it is not. Do not drop one.`
          : `# Discovery is finished (round ${req.discoveryRounds + 1} of ${MAX_DISCOVERY_ROUNDS} used). The record can support a plan, so send one rather than asking more.`
        : `# Discovery budget: round ${req.discoveryRounds + 1} of ${MAX_DISCOVERY_ROUNDS}. Ask ONLY if an answer would change the strategy — do not pad to a question count. A round where nothing further would change the campaign is itself a finding.`,
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
