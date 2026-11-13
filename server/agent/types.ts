// Campaign Designer: behavioural buckets, an isolated journey per bucket.
// Questions, then a built campaign, then changes through chat. No approvals.
//
// One agent, one prompt, every tool. Two stores on disk per chat:
//   - the CAMPAIGN OBJECT: what the core engine executes (goal, entry,
//     membership, buckets with rule + journey, everyone else);
//   - the CAMPAIGN CONTEXT: everything that supports it (answers, brief,
//     bucket reasoning, sizing, research, later metrics), append-only.
// And with the conversation:
//   - the FLAGS: progress booleans that all start false and turn true along the way;
//   - the TIMELINE: an append-only log of what changed and who changed it.
// Nothing here blocks the agent. The flags are guidance it reads, not gates.

import type { BpAudienceGroup, BpCondition, BpStep } from '../blueprint';

export type FlagName = 'goalClear' | 'successClear' | 'membershipClear' | 'questionsAnswered' | 'readyToDesign' | 'campaignBuilt';

export type Flags = Record<FlagName, boolean>;

export const FLAG_ORDER: FlagName[] = ['goalClear', 'successClear', 'membershipClear', 'questionsAnswered', 'readyToDesign', 'campaignBuilt'];

/** Flags the agent may set with `set_flags`. The rest belong to the app. */
export const AGENT_FLAGS: FlagName[] = ['goalClear', 'successClear', 'membershipClear', 'readyToDesign'];

export const FLAG_LABELS: Record<FlagName, string> = {
  goalClear: 'Goal clear',
  successClear: 'Success measure clear',
  membershipClear: 'Locked or open buckets decided',
  questionsAnswered: 'All questions answered',
  readyToDesign: 'Enough to design the campaign',
  campaignBuilt: 'Campaign built and up to date',
};

export type AnswerType = 'single' | 'multi' | 'open';

export interface AgentQuestion {
  id: string;
  aspect: string;
  text: string;
  answerType: AnswerType;
  /** single / multi only. "Other" is never stored here: the UI always adds it. */
  options?: string[];
  /** open only: example replies the manager can tap to fill the box. */
  suggestions?: string[];
  askedAt: string;
  answer?: string;
  answeredAt?: string;
  /** The manager chose not to answer: the agent assumes, and says so. */
  skipped?: boolean;
}

export type Evidence = 'measured' | 'manager' | 'hypothesis';

// --- the campaign object: what the core engine executes --------------------------

export interface CampaignBucket {
  id: string;
  name: string;
  /** Priority: lower is checked first. First match wins. */
  priority: number;
  /** The rule the engine evaluates: ANDed entity blocks. */
  rule: BpAudienceGroup[];
  /** A no-message share held back to measure this bucket's journey. */
  holdoutPct?: number;
  /** This bucket's isolated journey, from the building blocks. */
  journey: BpStep[] | null;
}

export interface CampaignObject {
  name?: string;
  description?: string;
  /** The event that proves success. Exits anyone who reaches it. */
  goal: { eventCategory: string; eventType: string; conditions?: BpCondition[] } | null;
  /** Who is eligible at all: everyone who has not reached the goal yet. */
  entry: { kind: 'audience'; entity: string; conditions?: BpCondition[]; groups?: BpAudienceGroup[] } | null;
  /** Locked: membership fixed at launch. Open: newly matching customers join on the refresh cadence. */
  membership: { type: 'locked' | 'open'; refresh?: 'daily' | 'weekly' | 'monthly' } | null;
  buckets: CampaignBucket[];
  /** What customers in no bucket get: a journey, or deliberately nothing. */
  everyoneElse: { approach: 'journey' | 'none'; journey?: BpStep[] } | null;
}

// --- the campaign context: everything that supports it ---------------------------

/**
 * answer: the manager's answer to a question (filed by the app). brief: what the
 * agent concluded or assumed, by aspect. bucket: a bucket's reasoning (topic
 * behaviour / thesis / evidence / metric). sizing: a bucket's size from the
 * warehouse. research: what the data showed. note: campaign-level reasoning
 * (segmentation, measurement, guardrails, everyone else). metric: results later.
 */
export type ContextKind = 'answer' | 'brief' | 'bucket' | 'research' | 'sizing' | 'note' | 'metric';
export type ContextSource = 'manager' | 'data' | 'assumption' | 'agent';

export interface ContextEntry {
  id: string;
  at: string;
  kind: ContextKind;
  /** What it is about, e.g. "Incentive", "thesis", "segmentation". */
  topic: string;
  bucketId?: string;
  text: string;
  source: ContextSource;
  /** Structured detail, e.g. { level } for evidence, { sql, size } for sizing. */
  data?: Record<string, unknown>;
}

/** Append-only. The current value of a (kind, bucket, topic) is its latest entry; history is kept. */
export interface CampaignContext {
  entries: ContextEntry[];
}

export type TimelineActor = 'agent' | 'user' | 'app';

export type TimelineType =
  | 'flag_changed'
  | 'questions_asked'
  | 'answers_received'
  | 'plan_section_updated'
  | 'bucket_updated'
  | 'bucket_removed'
  | 'bucket_sized'
  | 'journey_edited'
  | 'campaign_built'
  | 'build_failed'
  | 'context_added';

export interface TimelineEntry {
  at: string;
  actor: TimelineActor;
  type: TimelineType;
  note: string;
  flag?: FlagName;
  value?: boolean;
}

export interface AgentState {
  /** What the engine executes. Loaded from and saved to disk by the server. */
  campaign: CampaignObject;
  /** Everything that supports it. Loaded from and saved to disk by the server. */
  context: CampaignContext;
  flags: Flags;
  timeline: TimelineEntry[];
  questions: AgentQuestion[];
  questionSeq: number;
}

export interface AgentChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentRequest {
  sessionId: string;
  messages: AgentChatTurn[];
  tenantId?: string;
  knowledge?: unknown;
  state?: AgentState | null;
  /** Per-question answers from the form, keyed by question id. */
  answers?: Record<string, string>;
  /** Question ids the manager skipped (the Skip button, or left blank on Send). */
  skipped?: string[];
  /** The block the manager pointed at on the canvas (backend ids; turned into plain words for the agent). */
  focus?: { kind: 'step' | 'bucket' | 'entry' | 'goal' | 'everyone_else'; bucketId?: string; stepId?: string } | null;
}

export interface AgentResponse {
  sessionId: string;
  runId: string;
  reply: string;
  error?: string;
  errorDetail?: string;
  state: AgentState;
  /** Questions asked on THIS turn, for the form. */
  questionItems: AgentQuestion[];
  graph: unknown | null;
  campaign: unknown | null;
  buildNotes: string[];
  events: unknown[];
  warehouseAccess: boolean;
  /** The version this turn created, if it changed the campaign. */
  version?: { n: number; at: string; source: string; request: string; summary: string; counts: { added: number; changed: number; removed: number } };
}
