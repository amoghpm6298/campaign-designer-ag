// Client-side mirrors of the server contract. Hand-written rather than
// imported from server/ because those modules use node:fs and must never
// enter the browser bundle.
import type { DripCampaign, DripGraph } from '../data/graphTypes';

export type VerificationStatus = 'verified' | 'observation' | 'hypothesis' | 'invented' | 'authoritative';

export interface KnowledgeEntry {
  id: string;
  category: string;
  label: string;
  value: string;
  source: string;
  status: VerificationStatus;
  scope?: string;
  editedAt?: string;
}
/**
 * A document uploaded to give the agent context.
 *
 * `status` reflects what ACTUALLY happened, never the fact that a file was
 * chosen. Only a document whose text was successfully read and stored reaches
 * 'ready' — and only a 'ready' document is sent to the agent.
 */
export interface KnowledgeDocument {
  id: string;
  filename: string;
  /** Shared across tenants, or scoped to one tenant. */
  scope: 'shared' | string;
  sizeBytes: number;
  uploadedAt: string;
  status: 'ready' | 'failed';
  /** Present when status is 'failed'. */
  error?: string;
  /** The extracted text the agent reads. Absent when extraction failed. */
  text?: string;
}

export interface KnowledgeBase {
  version: string;
  entries: KnowledgeEntry[];
  documents?: KnowledgeDocument[];
}

export interface Capabilities {
  nodeTypes: { type: string; label: string; category: string }[];
  channels: string[];
  templates: { id: string; name: string; channelType: string; accountName: string }[];
  eventCategories: Record<string, string[]>;
  eligibilityAttributes: Record<string, string[]>;
  issuers: Record<string, string[]>;
  smartTagAttributes: string[];
  schemaContentHash: string;
  schemaArtefactVersion: string;
}

/** Mirrors server/runEvents.ts. One contract for live view and Run Logs. */
export interface RunEvent {
  runId: string;
  seq: number;
  at: string;
  type: string;
  stage: 'understanding' | 'discovery' | 'strategy' | 'generating' | 'validating' | 'review';
  status: 'running' | 'ok' | 'failed';
  title: string;
  detail?: string;
  durationMs?: number;
  data?: unknown;
  correlationId?: string;
}

export interface Strategy {
  summary: string;
  approach: string[];
  rejected?: { option: string; why: string }[];
  assumptions: string[];
  unknowns: string[];
  evidenceNotes?: string[];
}

export interface CheckResult {
  id: string;
  description: string;
  status: 'pass' | 'fail' | 'not-run';
  executedBy: string;
  detail?: string;
  unverifiedReason?: string;
  hardConstraint?: true;
}
export interface HardConstraintRecord {
  id: string;
  name: string;
  source: string;
  status: 'pass' | 'fail' | 'not-run' | 'not-applicable';
  detail: string;
  executedBy: string;
}
export interface ValidationReport {
  outcome: 'pre-validated' | 'incomplete' | 'failed';
  checks: CheckResult[];
  unverified: CheckResult[];
  hardConstraints: HardConstraintRecord[];
  unverifiedHardConstraints: string[];
}

/**
 * `revising` is the brief being closed while the PLAN still needs a change:
 * the journey draws, no numbered questions, and Confirm stays off. It is not
 * `discovery` — that word was doing three jobs and a manager with a finished
 * brief was told their answer was awaited.
 */
/**
 * `planning` is the brief closed with no path on file yet: nothing to draw,
 * nothing to approve, and the next turn's job is the plan. `revising` is the
 * same record state WITH a path — so it draws, and still cannot be approved.
 */
export type Phase =
  | 'understanding'
  | 'discovery'
  | 'planning'
  | 'revising'
  | 'awaiting-confirmation'
  | 'generating'
  | 'review'
  | 'error';

export interface DesignerResponse {
  sessionId: string;
  runId: string;
  phase: Phase;
  stage: 'discovery' | 'proposed' | 'blocked' | 'error';
  reply: string;
  questions: string[];
  strategy: Strategy | null;
  blueprint: unknown;
  pendingBlueprint: unknown;
  /** Opaque to the client — carried back unchanged on the next turn. */
  brief: unknown;
  session: unknown;
  discoveryReason?: string;
  /** Aggregated data the agent has asked for. Never a prerequisite. */
  evidenceRequests: {
    question: string;
    fields: string[];
    grouping?: string;
    period?: string;
    wouldInform: string;
  }[];
  campaign: DripCampaign | null;
  graph: DripGraph | null;
  provenance: Record<string, { basis: string; reference?: string; reason?: string; omitted?: true }> | null;
  unresolvedCampaignFields: string[];
  campaignBlockers: string[];
  validation: ValidationReport | null;
  buildIssues: { path: string; problem: string }[];
  templateChoices: { step: string; templateId: string | null; channel: string; reason: string }[];
  sendProposals: SendProposal[];
  discoveryRounds: number;
  discoveryLimitReached: boolean;
  /** A journey was constructed and carries no build issues. */
  designGenerated?: boolean;
  /** The design can be serialised and downloaded. Says nothing about import. */
  exportable: boolean;
  exportBlockedReason?: string;
  /**
   * Never 'ready'. The application has no JSON import path, so there is no
   * contract to verify against; `outstanding` is what a person must still
   * prepare before uploading by hand.
   */
  importReadiness?: {
    status: 'unverified';
    reason: string;
    outstanding: string[];
  } | null;
  events: RunEvent[];
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface Tenant {
  tenantId: string;
  displayName: string;
  issuer: string;
  synthetic: true;
  templateLibraryAccess: 'unavailable' | 'synthetic-demo';
}

/** Why a Send's account/template is not filled in. */
export type UnresolvedReason = 'template-library-unavailable' | 'no-suitable-template' | 'awaiting-user-input';

export interface SendProposal {
  nodeId: string;
  stepName: string;
  channel: string;
  timing: string;
  reason: UnresolvedReason;
  explanation: string;
  messagingDirection: string;
  sampleCopy: string;
  cta: string;
  personalisationFields: string[];
  accountResolved: boolean;
  templateResolved: boolean;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** One persisted run, for the Run Logs view. */
export interface RunLog {
  runId: string;
  sessionId: string;
  /** The tenant this run was executed for. Never reassigned. */
  tenantId?: string;
  startedAt: string;
  status: 'discovery' | 'proposed' | 'blocked' | 'error' | 'export';
  title: string;
  model: string;
  events: RunEvent[];
  validationOutcome?: string;
  knowledgeVersion?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** The campaign configuration as it stood at the end of this run. */
  campaignSnapshot?: DripCampaign | null;
  /**
   * Enough of the exchange to read the run back as a conversation.
   *
   * `title` is the user's message truncated to 90 characters, which is fine
   * as a row label and useless as a record. Without the reply and the
   * questions there was nothing to read: the log could show you that a turn
   * happened and what tools it called, but not what was said. These three
   * fields are what make the Run Logs tab a transcript rather than an
   * index.
   */
  userText?: string;
  reply?: string;
  questions?: string[];

  /**
   * WHAT THE AGENT WORKED OUT, not just what it said.
   *
   * Added 2026-10-21, after "is everything printed in logs? seems like some
   * info is incomplete" — it was. A run log carried the transcript, the event
   * stream and the finished campaign, and dropped the two artefacts the whole
   * agent exists to produce: the BRIEF (who converts, what is stopping the
   * rest, the lines of enquiry weighed and why) and the STRATEGY (the
   * candidate architectures, the one chosen and the reason). So the log could
   * tell you a proposal happened and never what was proposed.
   *
   * Measured on a real turn: brief 10.2 KB, strategy 9.6 KB. Paid for by not
   * storing `model.text.delta` events, which were 132 of that turn's 158 and
   * half its bytes — and which are the streaming transport, already
   * reassembled into `reply`. The log is smaller than it was AND complete.
   */
  brief?: unknown;
  strategy?: unknown;
  blueprint?: unknown;
  /** The phase this turn ended in, which `status` only approximates. */
  phase?: string;
  discoveryRounds?: number;
  /** Why the gate held, when it did. */
  discoveryReason?: string;
  /** The provider's untouched text on a failure. Kept everywhere, by rule. */
  errorDetail?: string;
}
