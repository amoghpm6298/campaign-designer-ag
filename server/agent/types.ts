// Campaign Designer: behavioural buckets, an isolated journey per bucket.
// Questions, then a built campaign, then changes through chat. No approvals.
//
// One agent, one prompt, every tool. The backend keeps:
//   - the PLAN FILE: brief, campaign shell, buckets (each with its own journey);
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

export interface BriefFinding {
  /** Short aspect label the agent chose, e.g. "Goal", "Timing", "Offer". */
  aspect: string;
  text: string;
  source: 'manager' | 'assumption' | 'data';
}

export type Evidence = 'measured' | 'manager' | 'hypothesis';

export interface Bucket {
  id: string;
  name: string;
  /** Priority: lower is checked first. First match wins. */
  priority: number;
  /** Plain-language definition of the behaviour. */
  behaviour: string;
  /** The rule the builder evaluates: ANDed entity blocks. */
  rule: BpAudienceGroup[];
  /** Warehouse only: SQL selecting this bucket's customer_ids, used to size it. */
  sql?: string;
  evidence: Evidence;
  /** The numbers or quotes behind the bucket. */
  evidenceNotes: string;
  size?: number;
  sizeError?: string;
  /** Why these customers are stuck, and the lever that will move them. */
  thesis: string;
  metric: string;
  holdoutPct?: number;
  /** This bucket's isolated journey, from the building blocks. */
  journey: BpStep[] | null;
  updatedAt: string;
}

export interface CampaignShell {
  name?: string;
  description?: string;
  /** The event that proves success. Exits anyone who reaches it. */
  goal: { eventCategory: string; eventType: string; conditions?: BpCondition[] } | null;
  /** Who is eligible at all: everyone who has not reached the goal yet. */
  entry: { kind: 'audience'; entity: string; conditions?: BpCondition[]; groups?: BpAudienceGroup[] } | null;
  /** Locked: membership fixed at launch. Open: newly matching customers join on the refresh cadence. */
  membership: { type: 'locked' | 'open'; refresh?: 'daily' | 'weekly' | 'monthly' } | null;
  segmentationLogic?: string;
  guardrails?: string;
  measurement?: string;
  /** What customers in no bucket get: a journey, or deliberately nothing. */
  everyoneElse?: { approach: 'journey' | 'none'; why?: string; journey?: BpStep[] } | null;
  updatedAt?: string;
}

export interface PlanFile {
  brief: { findings: BriefFinding[]; summary?: string; updatedAt?: string };
  campaign: CampaignShell | null;
  buckets: Bucket[];
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
  | 'build_failed';

export interface TimelineEntry {
  at: string;
  actor: TimelineActor;
  type: TimelineType;
  note: string;
  flag?: FlagName;
  value?: boolean;
}

export interface AgentState {
  planFile: PlanFile;
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
}
