// Client-side mirror of server/agent/types.ts. Kept separate so the browser
// bundle never imports server modules.

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

export const FLAG_LABELS: Record<FlagName, string> = {
  goalClear: 'Goal',
  successClear: 'Success measure',
  audienceClear: 'Audience',
  barriersClear: 'Barriers',
  questionsAnswered: 'Questions answered',
  briefReady: 'Brief ready',
  briefSignedOff: 'Brief signed off',
  planReady: 'Plan ready',
  planSignedOff: 'Plan signed off',
  campaignBuilt: 'Built',
};

export type AnswerType = 'single' | 'multi' | 'open';

export interface AgentQuestion {
  id: string;
  aspect: string;
  text: string;
  answerType: AnswerType;
  options?: string[];
  suggestions?: string[];
  answer?: string;
}

export interface BriefFinding {
  aspect: string;
  text: string;
  source: 'manager' | 'assumption';
}

export interface PlanFile {
  brief: { findings: BriefFinding[]; summary?: string };
  strategy: {
    hypothesis?: string;
    approach?: string;
    alternative?: string;
    whyNotAlternative?: string;
    measurement?: string;
    risks?: string[];
  } | null;
  journey: { blueprint: unknown } | null;
}

export interface TimelineEntry {
  at: string;
  actor: 'agent' | 'user' | 'app';
  type: string;
  note: string;
}

export interface AgentState {
  planFile: PlanFile;
  flags: Record<FlagName, boolean>;
  timeline: TimelineEntry[];
  questions: AgentQuestion[];
  pendingSignoff: 'brief' | 'plan' | null;
  questionSeq: number;
}

export interface V2Event {
  runId: string;
  seq: number;
  at: string;
  type: string;
  status: 'running' | 'ok' | 'failed';
  title: string;
  detail?: string;
  durationMs?: number;
  data?: { tool?: string; input?: unknown; result?: unknown; text?: string; round?: number } & Record<string, unknown>;
  correlationId?: string;
}

export interface AgentResponse {
  sessionId: string;
  runId: string;
  reply: string;
  error?: string;
  errorDetail?: string;
  state: AgentState;
  questionItems: AgentQuestion[];
  graph: unknown | null;
  campaign: unknown | null;
  buildNotes: string[];
  events: V2Event[];
}

export interface V2Turn {
  role: 'user' | 'assistant';
  content: string;
  /** Assistant turns: the questions asked on that turn, for the form. */
  questions?: AgentQuestion[];
  /** Assistant turns: the ordered trace of what the agent did. */
  events?: V2Event[];
  error?: string;
}

export type V2Action = { type: 'signoff'; section: 'brief' | 'plan' } | { type: 'request_changes'; section: 'brief' | 'plan'; note?: string };
