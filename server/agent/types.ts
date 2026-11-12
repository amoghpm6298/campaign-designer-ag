// Campaign Designer v2: one agent, one prompt, every tool on every turn.
//
// The backend keeps three things and passes them back to the agent each turn:
//   - the PLAN FILE: the living document the agent writes (brief, strategy, journey);
//   - the FLAGS: progress booleans that all start false and turn true along the way;
//   - the TIMELINE: an append-only log of everything that changed, and who changed it.
// Nothing here blocks the agent. The flags are guidance it reads, not gates.

import type { CampaignBlueprint } from '../blueprint';

export type FlagName =
  | 'goalClear'
  | 'successClear'
  | 'audienceClear'
  | 'barriersClear'
  | 'questionsAnswered'
  | 'briefReady'
  | 'briefSignedOff'
  | 'planReady'
  | 'planSignedOff'
  | 'campaignBuilt';

export type Flags = Record<FlagName, boolean>;

export const FLAG_ORDER: FlagName[] = [
  'goalClear',
  'successClear',
  'audienceClear',
  'barriersClear',
  'questionsAnswered',
  'briefReady',
  'briefSignedOff',
  'planReady',
  'planSignedOff',
  'campaignBuilt',
];

/** Flags the agent may set with `set_flags`. The rest belong to the user or the app. */
export const AGENT_FLAGS: FlagName[] = ['goalClear', 'successClear', 'audienceClear', 'barriersClear', 'briefReady', 'planReady'];

export const FLAG_LABELS: Record<FlagName, string> = {
  goalClear: 'Goal clear',
  successClear: 'Success measure clear',
  audienceClear: 'Audience clear',
  barriersClear: 'Barriers clear',
  questionsAnswered: 'All questions answered',
  briefReady: 'Brief ready',
  briefSignedOff: 'Brief signed off',
  planReady: 'Plan ready',
  planSignedOff: 'Plan signed off',
  campaignBuilt: 'Campaign built',
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
}

export interface BriefFinding {
  /** Short aspect label the agent chose, e.g. "Goal", "Timing", "Offer". */
  aspect: string;
  /** What we now know, in plain words. */
  text: string;
  /** Who said it: the manager, or the agent's own assumption. */
  source: 'manager' | 'assumption';
}

export interface PlanFile {
  brief: { findings: BriefFinding[]; summary?: string; updatedAt?: string };
  strategy: {
    hypothesis?: string;
    approach?: string;
    alternative?: string;
    whyNotAlternative?: string;
    measurement?: string;
    risks?: string[];
    updatedAt?: string;
  } | null;
  journey: { blueprint: CampaignBlueprint; updatedAt?: string } | null;
}

export type TimelineActor = 'agent' | 'user' | 'app';

export type TimelineType =
  | 'flag_changed'
  | 'questions_asked'
  | 'answers_received'
  | 'plan_section_updated'
  | 'signoff_requested'
  | 'signed_off'
  | 'changes_requested'
  | 'campaign_built'
  | 'build_failed'
  | 'acted_ahead_of_flags';

export interface TimelineEntry {
  at: string;
  actor: TimelineActor;
  type: TimelineType;
  note: string;
  flag?: FlagName;
  value?: boolean;
}

/** Everything the backend keeps between turns. The client carries it; the server owns the logic. */
export interface AgentState {
  planFile: PlanFile;
  flags: Flags;
  timeline: TimelineEntry[];
  questions: AgentQuestion[];
  /** Which section the agent last asked the manager to sign off, if still pending. */
  pendingSignoff: 'brief' | 'plan' | null;
  /** Monotonic counter for question ids. */
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
  /** A UI action rather than (or alongside) a typed message. */
  action?: { type: 'signoff'; section: 'brief' | 'plan' } | { type: 'request_changes'; section: 'brief' | 'plan'; note?: string } | null;
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
}
